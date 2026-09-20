import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { badRequest, notFound } from '../lib/errors';
import { hasGlobalView } from '../middleware/scope';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// All report endpoints return a table-friendly + export-friendly shape:
//   { columns: [...], rows: [...], generatedAt, summary? }
// Money is kept as paise; aggregates are returned as STRING paise so the client
// gets lossless BigInt values (the global BigInt serializer also handles raw
// BigInts, but aggregate sums are reduced to strings explicitly here).
// ─────────────────────────────────────────────────────────────────────────────

const generatedAt = () => new Date().toISOString();

/** Common date-range query used by most reports. */
const dateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const dateWhere = (from?: Date, to?: Date) =>
  from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

// ─────────────────────────────────────────────────────────────────────────────
// GET /leads — Lead Summary: counts per stage + row list.
// Filterable by source (sourceChannel), stage, agent (ownerId), campaign, dates.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/leads',
  authorize('reports.read'),
  validate({
    query: dateRangeQuery.extend({
      sourceChannel: z.string().optional(),
      stage: z.string().optional(),
      ownerId: z.string().uuid().optional(),
      campaignId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as {
      from?: Date;
      to?: Date;
      sourceChannel?: string;
      stage?: string;
      ownerId?: string;
      campaignId?: string;
    };
    const created = dateWhere(q.from, q.to);
    // Scope: non-global users see only their owned leads.
    const ownerScope = hasGlobalView(req.user!)
      ? q.ownerId
        ? { ownerId: q.ownerId }
        : {}
      : { ownerId: req.user!.id };
    const where: Prisma.LeadWhereInput = {
      ...ownerScope,
      ...(q.sourceChannel ? { sourceChannel: q.sourceChannel as never } : {}),
      ...(q.stage ? { stage: q.stage as never } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      ...(created ? { createdAt: created } : {}),
    };

    const [byStage, leads] = await Promise.all([
      prisma.lead.groupBy({ by: ['stage'], where, _count: { _all: true } }),
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          owner: { select: { name: true } },
          campaign: { select: { name: true } },
        },
      }),
    ]);

    const stageCounts: Record<string, number> = {};
    for (const g of byStage) stageCounts[g.stage] = g._count._all;

    res.json({
      columns: ['name', 'mobile', 'stage', 'sourceChannel', 'owner', 'campaign', 'score', 'createdAt'],
      rows: leads.map((l) => ({
        id: l.id,
        name: l.name,
        mobile: l.mobile,
        stage: l.stage,
        sourceChannel: l.sourceChannel,
        owner: l.owner?.name ?? null,
        campaign: l.campaign?.name ?? null,
        score: l.score,
        createdAt: l.createdAt,
      })),
      summary: { byStage: stageCounts, total: leads.length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /lead-aging — time in current stage + slaBreached per lead.
// NOTE: "time in current stage" is approximated as days since updatedAt, since
// the schema has no per-stage transition timestamp. updatedAt changes on the
// most recent mutation (typically the last stage change), so it is used as a
// proxy. Replace with a stage-history table if exact dwell time is required.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/lead-aging',
  authorize('reports.read'),
  validate({ query: z.object({ ownerId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { ownerId?: string };
    const ownerScope = hasGlobalView(req.user!)
      ? q.ownerId
        ? { ownerId: q.ownerId }
        : {}
      : { ownerId: req.user!.id };
    const where: Prisma.LeadWhereInput = {
      ...ownerScope,
      stage: { notIn: ['CONVERTED', 'LOST'] },
    };
    const leads = await prisma.lead.findMany({
      where,
      orderBy: { updatedAt: 'asc' },
      take: 1000,
      include: { owner: { select: { name: true } } },
    });
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const rows = leads.map((l) => ({
      id: l.id,
      name: l.name,
      stage: l.stage,
      owner: l.owner?.name ?? null,
      daysInStage: Math.floor((now - l.updatedAt.getTime()) / DAY),
      slaBreached: l.slaBreached,
    }));
    res.json({
      columns: ['name', 'stage', 'owner', 'daysInStage', 'slaBreached'],
      rows,
      summary: { total: rows.length, breached: rows.filter((r) => r.slaBreached).length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /site-visits — by agent, project, status, conversion.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/site-visits',
  authorize('reports.read'),
  validate({
    query: dateRangeQuery.extend({
      agentId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
      status: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as {
      from?: Date;
      to?: Date;
      agentId?: string;
      projectId?: string;
      status?: string;
    };
    const agentScope = hasGlobalView(req.user!)
      ? q.agentId
        ? { agentId: q.agentId }
        : {}
      : { agentId: req.user!.id };
    const scheduled = dateWhere(q.from, q.to);
    const where: Prisma.SiteVisitWhereInput = {
      ...agentScope,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(scheduled ? { scheduledAt: scheduled } : {}),
    };

    const [byStatus, visits, converted] = await Promise.all([
      prisma.siteVisit.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.siteVisit.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
        take: 500,
        include: {
          agent: { select: { name: true } },
          project: { select: { name: true } },
          unit: { select: { unitNumber: true } },
        },
      }),
      prisma.siteVisit.count({
        where: { ...where, status: 'COMPLETED', opportunity: { is: { stage: 'WON' } } },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const g of byStatus) statusCounts[g.status] = g._count._all;
    const completed = statusCounts.COMPLETED ?? 0;

    res.json({
      columns: ['scheduledAt', 'agent', 'project', 'unit', 'status'],
      rows: visits.map((v) => ({
        id: v.id,
        scheduledAt: v.scheduledAt,
        agent: v.agent?.name ?? null,
        project: v.project?.name ?? null,
        unit: v.unit?.unitNumber ?? null,
        status: v.status,
      })),
      summary: {
        byStatus: statusCounts,
        conversion: {
          completed,
          won: converted,
          rate: completed > 0 ? Number(((converted / completed) * 100).toFixed(2)) : 0,
        },
      },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /pipeline — opportunity pipeline by stage/value/agent/expected close.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/pipeline',
  authorize('reports.read'),
  validate({
    query: z.object({
      ownerId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { ownerId?: string; projectId?: string };
    const ownerScope = hasGlobalView(req.user!)
      ? q.ownerId
        ? { ownerId: q.ownerId }
        : {}
      : { ownerId: req.user!.id };
    const where: Prisma.OpportunityWhereInput = {
      ...ownerScope,
      ...(q.projectId ? { projectId: q.projectId } : {}),
    };

    const [byStage, opps] = await Promise.all([
      prisma.opportunity.groupBy({
        by: ['stage'],
        where,
        _count: { _all: true },
        _sum: { dealValuePaise: true },
      }),
      prisma.opportunity.findMany({
        where,
        orderBy: { expectedCloseAt: 'asc' },
        take: 500,
        include: {
          owner: { select: { name: true } },
          account: { select: { name: true } },
          project: { select: { name: true } },
        },
      }),
    ]);

    res.json({
      columns: ['name', 'account', 'project', 'owner', 'stage', 'probability', 'dealValuePaise', 'expectedCloseAt'],
      rows: opps.map((o) => ({
        id: o.id,
        name: o.name,
        account: o.account?.name ?? null,
        project: o.project?.name ?? null,
        owner: o.owner?.name ?? null,
        stage: o.stage,
        probability: o.probability,
        dealValuePaise: o.dealValuePaise.toString(),
        expectedCloseAt: o.expectedCloseAt,
      })),
      summary: {
        byStage: byStage.map((g) => ({
          stage: g.stage,
          count: g._count._all,
          valuePaise: (g._sum.dealValuePaise ?? 0n).toString(),
        })),
      },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /inventory — inventory status by project/tower/floor/unit/status.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/inventory',
  authorize('reports.read'),
  validate({
    query: z.object({
      projectId: z.string().uuid().optional(),
      towerId: z.string().uuid().optional(),
      status: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { projectId?: string; towerId?: string; status?: string };
    const where: Prisma.InventoryUnitWhereInput = {
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.towerId ? { towerId: q.towerId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
    };

    const [byStatus, units] = await Promise.all([
      prisma.inventoryUnit.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.inventoryUnit.findMany({
        where,
        orderBy: [{ floor: 'asc' }, { unitNumber: 'asc' }],
        take: 1000,
        include: {
          project: { select: { name: true } },
          tower: { select: { name: true } },
        },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const g of byStatus) statusCounts[g.status] = g._count._all;

    res.json({
      columns: ['project', 'tower', 'floor', 'unitNumber', 'type', 'status'],
      rows: units.map((u) => ({
        id: u.id,
        project: u.project?.name ?? null,
        tower: u.tower?.name ?? null,
        floor: u.floor,
        unitNumber: u.unitNumber,
        type: u.type,
        status: u.status,
      })),
      summary: { byStatus: statusCounts, total: units.length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /bookings — Booking Register: unit, customer, date, amount, agent.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/bookings',
  authorize('reports.read'),
  validate({
    query: dateRangeQuery.extend({
      projectId: z.string().uuid().optional(),
      agentId: z.string().uuid().optional(),
      status: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as {
      from?: Date;
      to?: Date;
      projectId?: string;
      agentId?: string;
      status?: string;
    };
    // Scope: agents see their bookings; channel partners see their CP bookings.
    const agentScope = hasGlobalView(req.user!)
      ? q.agentId
        ? { agentId: q.agentId }
        : {}
      : req.user!.role === 'CHANNEL_PARTNER'
        ? { channelPartnerId: req.user!.partnerAccountId }
        : { agentId: req.user!.id };
    const bookingDate = dateWhere(q.from, q.to);
    const where: Prisma.BookingWhereInput = {
      ...agentScope,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(bookingDate ? { bookingDate } : {}),
    };

    const [bookings, totals] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: { bookingDate: 'desc' },
        take: 500,
        include: {
          unit: { select: { unitNumber: true } },
          account: { select: { name: true } },
          agent: { select: { name: true } },
        },
      }),
      prisma.booking.aggregate({ where, _count: { _all: true }, _sum: { bookingAmountPaise: true, totalValuePaise: true } }),
    ]);

    res.json({
      columns: ['bookingNumber', 'unit', 'customer', 'bookingDate', 'bookingAmountPaise', 'agent', 'status'],
      rows: bookings.map((b) => ({
        id: b.id,
        bookingNumber: b.bookingNumber,
        unit: b.unit?.unitNumber ?? null,
        customer: b.account?.name ?? null,
        bookingDate: b.bookingDate,
        bookingAmountPaise: b.bookingAmountPaise.toString(),
        agent: b.agent?.name ?? null,
        status: b.status,
      })),
      summary: {
        count: totals._count._all,
        bookingAmountPaise: (totals._sum.bookingAmountPaise ?? 0n).toString(),
        totalValuePaise: (totals._sum.totalValuePaise ?? 0n).toString(),
      },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /collections — Collection Report: booking, demand, receipt, date, mode.
// Joins receipts → bookings via Prisma relation includes.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/collections',
  authorize('reports.read'),
  validate({
    query: dateRangeQuery.extend({
      projectId: z.string().uuid().optional(),
      mode: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { from?: Date; to?: Date; projectId?: string; mode?: string };
    const received = dateWhere(q.from, q.to);
    // Scope through the parent booking for agents / channel partners.
    const bookingScope = hasGlobalView(req.user!)
      ? {}
      : req.user!.role === 'CHANNEL_PARTNER'
        ? { booking: { is: { channelPartnerId: req.user!.partnerAccountId } } }
        : { booking: { is: { agentId: req.user!.id } } };
    const where: Prisma.ReceiptWhereInput = {
      ...bookingScope,
      ...(q.mode ? { mode: q.mode as never } : {}),
      ...(received ? { receivedAt: received } : {}),
      ...(q.projectId ? { booking: { is: { projectId: q.projectId } } } : {}),
    };

    const [receipts, totals] = await Promise.all([
      prisma.receipt.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: 500,
        include: {
          booking: { select: { bookingNumber: true, account: { select: { name: true } } } },
          allocations: { include: { demand: { select: { demandNumber: true, milestoneLabel: true } } } },
        },
      }),
      prisma.receipt.aggregate({ where, _count: { _all: true }, _sum: { amountPaise: true, gstPaise: true } }),
    ]);

    res.json({
      columns: ['receiptNumber', 'booking', 'customer', 'demands', 'receivedAt', 'mode', 'amountPaise'],
      rows: receipts.map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        booking: r.booking?.bookingNumber ?? null,
        customer: r.booking?.account?.name ?? null,
        demands: r.allocations.map((a) => a.demand?.demandNumber).filter(Boolean),
        receivedAt: r.receivedAt,
        mode: r.mode,
        amountPaise: r.amountPaise.toString(),
      })),
      summary: {
        count: totals._count._all,
        collectedPaise: (totals._sum.amountPaise ?? 0n).toString(),
        gstPaise: (totals._sum.gstPaise ?? 0n).toString(),
      },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /outstanding — Demand Outstanding: booking, overdue amount, days overdue.
// Outstanding = totalPaise - paidPaise for non-PAID demands.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/outstanding',
  authorize('reports.read'),
  validate({ query: z.object({ projectId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { projectId?: string };
    const bookingScope = hasGlobalView(req.user!)
      ? {}
      : req.user!.role === 'CHANNEL_PARTNER'
        ? { booking: { is: { channelPartnerId: req.user!.partnerAccountId } } }
        : { booking: { is: { agentId: req.user!.id } } };
    const where: Prisma.DemandScheduleWhereInput = {
      ...bookingScope,
      status: { notIn: ['PAID'] },
      ...(q.projectId ? { booking: { is: { projectId: q.projectId } } } : {}),
    };

    const demands = await prisma.demandSchedule.findMany({
      where,
      orderBy: { dueDate: 'asc' },
      take: 1000,
      include: { booking: { select: { bookingNumber: true, account: { select: { name: true } } } } },
    });

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    let outstandingTotal = 0n;
    const rows = demands.map((d) => {
      const outstanding = d.totalPaise - d.paidPaise;
      outstandingTotal += outstanding;
      const daysOverdue = d.dueDate.getTime() < now ? Math.floor((now - d.dueDate.getTime()) / DAY) : 0;
      return {
        id: d.id,
        demandNumber: d.demandNumber,
        booking: d.booking?.bookingNumber ?? null,
        customer: d.booking?.account?.name ?? null,
        milestoneLabel: d.milestoneLabel,
        dueDate: d.dueDate,
        status: d.status,
        outstandingPaise: outstanding.toString(),
        daysOverdue,
      };
    });

    res.json({
      columns: ['demandNumber', 'booking', 'customer', 'milestoneLabel', 'dueDate', 'status', 'outstandingPaise', 'daysOverdue'],
      rows,
      summary: { count: rows.length, outstandingPaise: outstandingTotal.toString() },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /agent-performance — per agent: leads, visits, bookings, collections.
// Collections summed via receipt → booking.agentId join (groupBy unsupported
// across relations, so receipts are summed per agent in app code).
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/agent-performance',
  authorize('reports.read'),
  asyncHandler(async (req, res) => {
    // Scope: privileged users see all agents; an agent sees only themselves.
    const agentFilter = hasGlobalView(req.user!) ? {} : { id: req.user!.id };
    const agents = await prisma.user.findMany({
      where: { ...agentFilter, role: { name: { in: ['SALES_AGENT', 'CHANNEL_PARTNER'] } } },
      select: { id: true, name: true },
    });
    const agentIds = agents.map((a) => a.id);

    const [leadGroups, visitGroups, bookingGroups, receipts] = await Promise.all([
      prisma.lead.groupBy({ by: ['ownerId'], where: { ownerId: { in: agentIds } }, _count: { _all: true } }),
      prisma.siteVisit.groupBy({ by: ['agentId'], where: { agentId: { in: agentIds } }, _count: { _all: true } }),
      prisma.booking.groupBy({ by: ['agentId'], where: { agentId: { in: agentIds } }, _count: { _all: true } }),
      prisma.receipt.findMany({
        where: { booking: { is: { agentId: { in: agentIds } } } },
        select: { amountPaise: true, booking: { select: { agentId: true } } },
      }),
    ]);

    const leadMap = new Map(leadGroups.map((g) => [g.ownerId, g._count._all]));
    const visitMap = new Map(visitGroups.map((g) => [g.agentId, g._count._all]));
    const bookingMap = new Map(bookingGroups.map((g) => [g.agentId, g._count._all]));
    const collMap = new Map<string, bigint>();
    for (const r of receipts) {
      const aid = r.booking.agentId;
      collMap.set(aid, (collMap.get(aid) ?? 0n) + r.amountPaise);
    }

    const rows = agents.map((a) => ({
      agentId: a.id,
      agent: a.name,
      leads: leadMap.get(a.id) ?? 0,
      siteVisits: visitMap.get(a.id) ?? 0,
      bookings: bookingMap.get(a.id) ?? 0,
      collectionsPaise: (collMap.get(a.id) ?? 0n).toString(),
    }));

    res.json({
      columns: ['agent', 'leads', 'siteVisits', 'bookings', 'collectionsPaise'],
      rows,
      summary: { agents: rows.length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cp-performance — per channel partner account: leads, bookings, commission.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/cp-performance',
  authorize('reports.read'),
  asyncHandler(async (req, res) => {
    // A CP user is scoped to their own partner account; privileged users see all.
    const accountFilter = hasGlobalView(req.user!)
      ? { type: 'CHANNEL_PARTNER' as const }
      : req.user!.role === 'CHANNEL_PARTNER' && req.user!.partnerAccountId
        ? { id: req.user!.partnerAccountId }
        : { id: '__none__' };
    const partners = await prisma.account.findMany({
      where: accountFilter,
      select: { id: true, name: true },
    });
    const ids = partners.map((p) => p.id);

    const [leadGroups, bookingGroups] = await Promise.all([
      // Leads attributed to the CP account via Lead.accountId.
      prisma.lead.groupBy({ by: ['accountId'], where: { accountId: { in: ids } }, _count: { _all: true } }),
      prisma.booking.groupBy({
        by: ['channelPartnerId'],
        where: { channelPartnerId: { in: ids } },
        _count: { _all: true },
        _sum: { commissionPaise: true },
      }),
    ]);

    const leadMap = new Map(leadGroups.map((g) => [g.accountId, g._count._all]));
    const bookingMap = new Map(bookingGroups.map((g) => [g.channelPartnerId, g]));

    const rows = partners.map((p) => {
      const bg = bookingMap.get(p.id);
      return {
        accountId: p.id,
        partner: p.name,
        leads: leadMap.get(p.id) ?? 0,
        bookings: bg?._count._all ?? 0,
        commissionPaise: (bg?._sum.commissionPaise ?? 0n).toString(),
      };
    });

    res.json({
      columns: ['partner', 'leads', 'bookings', 'commissionPaise'],
      rows,
      summary: { partners: rows.length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /campaign-roi — per campaign: leads, CPL, bookings, revenue.
// Mirrors the logic in campaigns.routes.ts analytics, aggregated per campaign.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/campaign-roi',
  authorize('reports.read'),
  asyncHandler(async (_req, res) => {
    const campaigns = await prisma.campaign.findMany({
      select: { id: true, name: true, budgetPaise: true, actualSpendPaise: true },
    });
    const ids = campaigns.map((c) => c.id);

    const [leadGroups, oppGroups, wonGroups] = await Promise.all([
      prisma.lead.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids } }, _count: { _all: true } }),
      prisma.opportunity.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids } }, _count: { _all: true } }),
      prisma.opportunity.groupBy({
        by: ['campaignId'],
        where: { campaignId: { in: ids }, stage: 'WON' },
        _count: { _all: true },
        _sum: { dealValuePaise: true },
      }),
    ]);

    const leadMap = new Map(leadGroups.map((g) => [g.campaignId, g._count._all]));
    const oppMap = new Map(oppGroups.map((g) => [g.campaignId, g._count._all]));
    const wonMap = new Map(wonGroups.map((g) => [g.campaignId, g]));

    const rows = campaigns.map((c) => {
      const leads = leadMap.get(c.id) ?? 0;
      const won = wonMap.get(c.id);
      const bookings = won?._count._all ?? 0;
      const revenue = won?._sum.dealValuePaise ?? 0n;
      const spend = c.actualSpendPaise > 0n ? c.actualSpendPaise : c.budgetPaise;
      const cpl = leads > 0 ? spend / BigInt(leads) : 0n;
      const roi = spend > 0n ? Number(((revenue - spend) * 10000n) / spend) / 100 : 0;
      return {
        campaignId: c.id,
        campaign: c.name,
        leads,
        opportunities: oppMap.get(c.id) ?? 0,
        bookings,
        costPerLeadPaise: cpl.toString(),
        spendPaise: spend.toString(),
        revenuePaise: revenue.toString(),
        roiPercent: roi,
      };
    });

    res.json({
      columns: ['campaign', 'leads', 'opportunities', 'bookings', 'costPerLeadPaise', 'spendPaise', 'revenuePaise', 'roiPercent'],
      rows,
      summary: { campaigns: rows.length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cancellations — cancelled bookings: reason, refundStatus.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/cancellations',
  authorize('reports.read'),
  validate({ query: dateRangeQuery.extend({ projectId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { from?: Date; to?: Date; projectId?: string };
    const cancelled = dateWhere(q.from, q.to);
    const agentScope = hasGlobalView(req.user!)
      ? {}
      : req.user!.role === 'CHANNEL_PARTNER'
        ? { channelPartnerId: req.user!.partnerAccountId }
        : { agentId: req.user!.id };
    const where: Prisma.BookingWhereInput = {
      ...agentScope,
      status: 'CANCELLED',
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(cancelled ? { cancelledAt: cancelled } : {}),
    };

    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { cancelledAt: 'desc' },
      take: 500,
      include: {
        unit: { select: { unitNumber: true } },
        account: { select: { name: true } },
        agent: { select: { name: true } },
      },
    });

    let chargesTotal = 0n;
    for (const b of bookings) chargesTotal += b.cancellationChargesPaise ?? 0n;

    res.json({
      columns: ['bookingNumber', 'unit', 'customer', 'agent', 'cancelledAt', 'cancellationReason', 'cancellationChargesPaise', 'refundStatus'],
      rows: bookings.map((b) => ({
        id: b.id,
        bookingNumber: b.bookingNumber,
        unit: b.unit?.unitNumber ?? null,
        customer: b.account?.name ?? null,
        agent: b.agent?.name ?? null,
        cancelledAt: b.cancelledAt,
        cancellationReason: b.cancellationReason,
        cancellationChargesPaise: (b.cancellationChargesPaise ?? 0n).toString(),
        refundStatus: b.refundStatus,
      })),
      summary: { count: bookings.length, cancellationChargesPaise: chargesTotal.toString() },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /custom — Custom report builder (reports.build).
//
// SAFE generic querying: user input never reaches raw SQL. We accept only a
// fixed WHITELIST of modules and, per module, a whitelist of selectable /
// filterable fields. Field names from the request are validated against the
// whitelist before being used in a typed Prisma query; values are passed as
// typed Prisma arguments (parameterized), never string-interpolated. Operators
// are mapped to a fixed set of Prisma filter keys.
// ─────────────────────────────────────────────────────────────────────────────

type WhitelistModule = 'lead' | 'opportunity' | 'booking' | 'account' | 'siteVisit';

// Per-module allowed fields and the matching Prisma delegate accessor.
const REPORT_WHITELIST: Record<
  WhitelistModule,
  { fields: string[]; delegate: () => { findMany: Function; groupBy: Function } }
> = {
  lead: {
    fields: ['id', 'name', 'mobile', 'email', 'stage', 'score', 'sourceChannel', 'ownerId', 'campaignId', 'createdAt', 'updatedAt'],
    delegate: () => prisma.lead,
  },
  opportunity: {
    fields: ['id', 'name', 'stage', 'probability', 'dealValuePaise', 'ownerId', 'accountId', 'projectId', 'expectedCloseAt', 'createdAt'],
    delegate: () => prisma.opportunity,
  },
  booking: {
    fields: ['id', 'bookingNumber', 'status', 'bookingAmountPaise', 'totalValuePaise', 'agentId', 'accountId', 'projectId', 'channelPartnerId', 'bookingDate', 'createdAt'],
    delegate: () => prisma.booking,
  },
  account: {
    fields: ['id', 'name', 'type', 'city', 'state', 'kycStatus', 'empanelmentStatus', 'ownerId', 'createdAt'],
    delegate: () => prisma.account,
  },
  siteVisit: {
    fields: ['id', 'status', 'scheduledAt', 'agentId', 'projectId', 'unitId', 'isWalkIn', 'createdAt'],
    delegate: () => prisma.siteVisit,
  },
};

const customBody = z.object({
  module: z.enum(['lead', 'opportunity', 'booking', 'account', 'siteVisit']),
  fields: z.array(z.string()).min(1),
  filters: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(['eq', 'contains', 'gt', 'lt', 'gte', 'lte']),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
    )
    .default([]),
  groupBy: z.string().optional(),
  aggregate: z
    .object({
      fn: z.enum(['SUM', 'COUNT', 'AVG']),
      field: z.string(),
    })
    .optional(),
});

router.post(
  '/custom',
  authorize('reports.build'),
  validate({ body: customBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof customBody>;
    const spec = REPORT_WHITELIST[b.module as WhitelistModule];
    const allowed = new Set(spec.fields);

    // Validate every referenced field against the whitelist.
    for (const f of b.fields) if (!allowed.has(f)) throw badRequest(`Field not allowed: ${f}`);
    for (const f of b.filters) if (!allowed.has(f.field)) throw badRequest(`Filter field not allowed: ${f.field}`);
    if (b.groupBy && !allowed.has(b.groupBy)) throw badRequest(`groupBy field not allowed: ${b.groupBy}`);
    if (b.aggregate && b.aggregate.fn !== 'COUNT' && !allowed.has(b.aggregate.field)) {
      throw badRequest(`aggregate field not allowed: ${b.aggregate.field}`);
    }

    // Build a typed Prisma `where` from the validated filters. Values are passed
    // through Prisma's parameterized API — never interpolated into SQL.
    const where: Record<string, unknown> = {};
    for (const f of b.filters) {
      switch (f.op) {
        case 'eq':
          where[f.field] = f.value;
          break;
        case 'contains':
          where[f.field] = { contains: String(f.value), mode: 'insensitive' };
          break;
        case 'gt':
        case 'lt':
        case 'gte':
        case 'lte':
          where[f.field] = { [f.op]: f.value };
          break;
      }
    }

    const delegate = spec.delegate();

    if (b.groupBy && b.aggregate) {
      const fnKey = b.aggregate.fn === 'SUM' ? '_sum' : b.aggregate.fn === 'AVG' ? '_avg' : '_count';
      const aggArg =
        b.aggregate.fn === 'COUNT'
          ? { _count: { _all: true } }
          : { [fnKey]: { [b.aggregate.field]: true } };
      const grouped = (await delegate.groupBy({
        by: [b.groupBy],
        where,
        ...aggArg,
      })) as Array<Record<string, unknown>>;
      // Coerce any BigInt aggregate values to strings for lossless transport.
      const rows = grouped.map((g) => {
        const out: Record<string, unknown> = { [b.groupBy as string]: g[b.groupBy as string] };
        const agg = g[fnKey] as Record<string, unknown> | undefined;
        if (agg) {
          for (const [k, v] of Object.entries(agg)) out[`${fnKey}_${k}`] = typeof v === 'bigint' ? v.toString() : v;
        }
        return out;
      });
      return res.json({
        columns: [b.groupBy, `${fnKey}_${b.aggregate.field}`],
        rows,
        summary: { groups: rows.length },
        generatedAt: generatedAt(),
      });
    }

    // Plain projection: select only whitelisted fields.
    const select: Record<string, boolean> = {};
    for (const f of b.fields) select[f] = true;
    const rows = (await delegate.findMany({ where, select, take: 1000 })) as Array<Record<string, unknown>>;
    // BigInt fields are serialized to strings by the global serializer, but
    // normalize here too for predictable export output.
    const normalized = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' ? v.toString() : v;
      return out;
    });

    res.json({
      columns: b.fields,
      rows: normalized,
      summary: { total: normalized.length },
      generatedAt: generatedAt(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Saved reports — user-owned report definitions.
// ─────────────────────────────────────────────────────────────────────────────

const savedBody = z.object({
  name: z.string().min(1),
  module: z.string().min(1),
  definition: z.record(z.string(), z.unknown()),
  schedule: z.string().optional(),
});

// GET /saved — list the caller's saved reports.
router.get(
  '/saved',
  authorize('reports.read'),
  asyncHandler(async (req, res) => {
    const reports = await prisma.savedReport.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ data: reports });
  }),
);

// POST /saved — save a report definition.
router.post(
  '/saved',
  authorize('reports.build'),
  validate({ body: savedBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof savedBody>;
    const report = await prisma.savedReport.create({
      data: {
        ownerId: req.user!.id,
        name: b.name,
        module: b.module,
        definition: b.definition as Prisma.InputJsonValue,
        schedule: b.schedule,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'reports',
      entity: 'SavedReport',
      entityId: report.id,
      newValue: report,
    });
    res.status(201).json(report);
  }),
);

// GET /saved/:id — fetch one of the caller's saved reports.
router.get(
  '/saved/:id',
  authorize('reports.read'),
  asyncHandler(async (req, res) => {
    const report = await prisma.savedReport.findUnique({ where: { id: req.params.id } });
    if (!report || report.ownerId !== req.user!.id) throw notFound('Saved report not found');
    res.json(report);
  }),
);

// DELETE /saved/:id — delete one of the caller's own saved reports.
router.delete(
  '/saved/:id',
  authorize('reports.build'),
  asyncHandler(async (req, res) => {
    const report = await prisma.savedReport.findUnique({ where: { id: req.params.id } });
    if (!report || report.ownerId !== req.user!.id) throw notFound('Saved report not found');
    await prisma.savedReport.delete({ where: { id: report.id } });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.DELETE,
      module: 'reports',
      entity: 'SavedReport',
      entityId: report.id,
    });
    res.json({ ok: true });
  }),
);

export default router;
