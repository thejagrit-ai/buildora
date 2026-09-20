import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { hasGlobalView } from '../middleware/scope';

const router = Router();

// Default collection / revenue targets (paise) when SystemConfig 'targets' is
// unset. Stored under SystemConfig key 'targets' as { collectionsPaise, revenuePaise }.
const DEFAULT_COLLECTIONS_TARGET_PAISE = 0n;
const DEFAULT_REVENUE_TARGET_PAISE = 0n;

const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

// ─────────────────────────────────────────────────────────────────────────────
// GET /kpis — headline dashboard metrics for the current user's scope.
// Uses Promise.all to fan out all the independent aggregate queries.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/kpis',
  authorize('reports.read'),
  validate({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      projectId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { from?: Date; to?: Date; projectId?: string };
    const user = req.user!;
    const global = hasGlobalView(user);

    const now = new Date();
    const monthStart = startOfMonth(now);
    const dateRange =
      q.from || q.to
        ? { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) }
        : undefined;

    // Scope fragments per entity (owner/agent based; CP via partner account).
    const leadScope: Prisma.LeadWhereInput = global ? {} : { ownerId: user.id };
    const oppScope: Prisma.OpportunityWhereInput = global ? {} : { ownerId: user.id };
    const visitScope: Prisma.SiteVisitWhereInput = global ? {} : { agentId: user.id };
    const bookingScope: Prisma.BookingWhereInput = global
      ? {}
      : user.role === 'CHANNEL_PARTNER'
        ? { channelPartnerId: user.partnerAccountId }
        : { agentId: user.id };
    const receiptBookingScope: Prisma.ReceiptWhereInput = global
      ? {}
      : user.role === 'CHANNEL_PARTNER'
        ? { booking: { is: { channelPartnerId: user.partnerAccountId } } }
        : { booking: { is: { agentId: user.id } } };

    // Leads carry no projectId, so the projectId filter does not apply to leads.
    const projectOpp = q.projectId ? { projectId: q.projectId } : {};
    const projectVisit = q.projectId ? { projectId: q.projectId } : {};
    const projectBooking = q.projectId ? { projectId: q.projectId } : {};
    const projectUnit = q.projectId ? { projectId: q.projectId } : {};

    const leadWhere: Prisma.LeadWhereInput = {
      ...leadScope,
      ...(dateRange ? { createdAt: dateRange } : {}),
    };

    const [
      totalLeads,
      convertedLeads,
      pipelineByStage,
      visitsScheduled,
      visitsCompleted,
      inventoryByStatus,
      collectionsThisMonth,
      overdueAgg,
      bookingAgents,
      revenueBooked,
      targetsConfig,
    ] = await Promise.all([
      prisma.lead.count({ where: leadWhere }),
      prisma.lead.count({ where: { ...leadWhere, stage: 'CONVERTED' } }),
      prisma.opportunity.groupBy({
        by: ['stage'],
        where: { ...oppScope, ...projectOpp },
        _count: { _all: true },
        _sum: { dealValuePaise: true },
      }),
      prisma.siteVisit.count({ where: { ...visitScope, ...projectVisit, status: 'SCHEDULED' } }),
      prisma.siteVisit.count({ where: { ...visitScope, ...projectVisit, status: 'COMPLETED' } }),
      prisma.inventoryUnit.groupBy({
        by: ['status'],
        where: { ...projectUnit },
        _count: { _all: true },
      }),
      prisma.receipt.aggregate({
        where: { ...receiptBookingScope, receivedAt: { gte: monthStart } },
        _sum: { amountPaise: true },
      }),
      prisma.demandSchedule.aggregate({
        where: {
          status: { notIn: ['PAID'] },
          dueDate: { lt: now },
          ...(q.projectId ? { booking: { is: { projectId: q.projectId } } } : {}),
          ...(global
            ? {}
            : user.role === 'CHANNEL_PARTNER'
              ? { booking: { is: { channelPartnerId: user.partnerAccountId } } }
              : { booking: { is: { agentId: user.id } } }),
        },
        _count: { _all: true },
        _sum: { totalPaise: true, paidPaise: true },
      }),
      prisma.booking.groupBy({
        by: ['agentId'],
        where: { ...bookingScope, ...projectBooking, status: { not: 'CANCELLED' } },
        _count: { _all: true },
      }),
      prisma.booking.aggregate({
        where: { ...bookingScope, ...projectBooking, status: { not: 'CANCELLED' } },
        _sum: { totalValuePaise: true },
      }),
      prisma.systemConfig.findUnique({
        where: { organizationId_key: { organizationId: req.user!.organizationId!, key: 'targets' } },
      }),
    ]);

    // Inventory donut counts.
    const inv: Record<string, number> = { available: 0, blocked: 0, booked: 0, registered: 0 };
    for (const g of inventoryByStatus) {
      if (g.status === 'AVAILABLE') inv.available = g._count._all;
      else if (g.status === 'BLOCKED') inv.blocked = g._count._all;
      else if (g.status === 'BOOKED') inv.booked = g._count._all;
      else if (g.status === 'REGISTERED') inv.registered = g._count._all;
    }

    // Top 5 agents by booking count, resolved to names.
    const sortedAgents = [...bookingAgents].sort((a, b) => b._count._all - a._count._all).slice(0, 5);
    const agentNames = await prisma.user.findMany({
      where: { id: { in: sortedAgents.map((a) => a.agentId) } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(agentNames.map((u) => [u.id, u.name]));
    const topAgents = sortedAgents.map((a) => ({
      agentId: a.agentId,
      name: nameMap.get(a.agentId) ?? null,
      bookings: a._count._all,
    }));

    // Targets from SystemConfig 'targets' JSON, falling back to defaults.
    const targets = (targetsConfig?.value ?? {}) as {
      collectionsPaise?: string | number;
      revenuePaise?: string | number;
    };
    const collectionsTargetPaise =
      targets.collectionsPaise != null ? BigInt(targets.collectionsPaise) : DEFAULT_COLLECTIONS_TARGET_PAISE;
    const revenueTargetPaise =
      targets.revenuePaise != null ? BigInt(targets.revenuePaise) : DEFAULT_REVENUE_TARGET_PAISE;

    const overdueValuePaise =
      (overdueAgg._sum.totalPaise ?? 0n) - (overdueAgg._sum.paidPaise ?? 0n);

    res.json({
      totalLeads,
      conversionRate: totalLeads > 0 ? Number(((convertedLeads / totalLeads) * 100).toFixed(2)) : 0,
      pipelineByStage: pipelineByStage.map((g) => ({
        stage: g.stage,
        count: g._count._all,
        valuePaise: (g._sum.dealValuePaise ?? 0n).toString(),
      })),
      siteVisitsScheduled: visitsScheduled,
      siteVisitsCompleted: visitsCompleted,
      inventory: inv,
      collectionsThisMonthPaise: (collectionsThisMonth._sum.amountPaise ?? 0n).toString(),
      collectionsTargetPaise: collectionsTargetPaise.toString(),
      overdueDemandsCount: overdueAgg._count._all,
      overdueValuePaise: overdueValuePaise.toString(),
      topAgents,
      revenueBookedPaise: (revenueBooked._sum.totalValuePaise ?? 0n).toString(),
      revenueTargetPaise: revenueTargetPaise.toString(),
      generatedAt: new Date().toISOString(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /widgets — the caller's dashboard widget layout.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/widgets',
  authorize('reports.read'),
  asyncHandler(async (req, res) => {
    const widgets = await prisma.dashboardWidget.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: widgets });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /widgets/layout — replace the caller's widget layout.
// Deletes widgets no longer present and upserts the provided set, in one tx.
// ─────────────────────────────────────────────────────────────────────────────
const layoutBody = z.object({
  widgets: z.array(
    z.object({
      widgetKey: z.string().min(1),
      layout: z.record(z.string(), z.unknown()),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

router.put(
  '/widgets/layout',
  authorize('reports.read'),
  validate({ body: layoutBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof layoutBody>;
    const ownerId = req.user!.id;
    const keys = b.widgets.map((w) => w.widgetKey);

    const result = await prisma.$transaction(async (tx) => {
      // Remove widgets the user no longer has in their layout.
      await tx.dashboardWidget.deleteMany({
        where: { ownerId, widgetKey: { notIn: keys.length ? keys : ['__none__'] } },
      });
      // Upsert each provided widget. (widgetKey is not unique in schema, so we
      // emulate upsert via find-then-update/create scoped to the owner.)
      for (const w of b.widgets) {
        const existing = await tx.dashboardWidget.findFirst({
          where: { ownerId, widgetKey: w.widgetKey },
          select: { id: true },
        });
        const data = {
          layout: w.layout as Prisma.InputJsonValue,
          config: w.config === undefined ? Prisma.JsonNull : (w.config as Prisma.InputJsonValue),
        };
        if (existing) {
          await tx.dashboardWidget.update({ where: { id: existing.id }, data });
        } else {
          await tx.dashboardWidget.create({ data: { ownerId, widgetKey: w.widgetKey, ...data } });
        }
      }
      return tx.dashboardWidget.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } });
    });

    res.json({ data: result });
  }),
);

export default router;
