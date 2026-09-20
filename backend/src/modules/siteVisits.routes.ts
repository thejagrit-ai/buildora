import { Router } from 'express';
import { z } from 'zod';
import { ActivityType, AuditAction, VisitStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { hasGlobalView } from '../middleware/scope';
import { notifyUser } from '../lib/notify';

const router = Router();

const statusEnum = z.enum(['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED']);

// Allowed status transitions. SCHEDULED → CONFIRMED → COMPLETED, with NO_SHOW /
// CANCELLED reachable from the active states.
const TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED'],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
};

// ── Schemas ─────────────────────────────────────────────────────────────────

const scheduleBody = z.object({
  scheduledAt: z.coerce.date(),
  projectId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  transport: z.string().optional(),
});

const feedbackBody = z.object({
  rating: z.number().int().min(1).max(5),
  interestedUnits: z.string().optional(),
  budgetConfirmed: z.boolean().default(false),
  nextAction: z.string().optional(),
  remarks: z.string().optional(),
});

const walkInBody = z.object({
  projectId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  transport: z.string().optional(),
});

// GET /api/site-visits  — paginated list.
// Agents see only their own visits unless they have global view.
router.get(
  '/',
  authorize('siteVisits.read'),
  validate({
    query: listQuerySchema.extend({
      agentId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
      status: statusEnum.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & {
      agentId?: string;
      projectId?: string;
      status?: VisitStatus;
      from?: Date;
      to?: Date;
    };
    // Scope: non-global users are pinned to their own agentId.
    const agentScope = hasGlobalView(req.user!)
      ? q.agentId
        ? { agentId: q.agentId }
        : {}
      : { agentId: req.user!.id };
    const scheduledAt =
      q.from || q.to
        ? { scheduledAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {};
    const where = {
      ...agentScope,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...scheduledAt,
    };
    const [data, total] = await Promise.all([
      prisma.siteVisit.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort, { scheduledAt: 'desc' }),
        include: {
          project: { select: { name: true } },
          unit: { select: { unitNumber: true } },
          agent: { select: { name: true } },
          feedback: true,
        },
      }),
      prisma.siteVisit.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// GET /api/site-visits/calendar  — visits in a date range grouped by day.
router.get(
  '/calendar',
  authorize('siteVisits.read'),
  validate({
    query: z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      agentId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as {
      from: Date;
      to: Date;
      agentId?: string;
      projectId?: string;
    };
    const agentScope = hasGlobalView(req.user!)
      ? q.agentId
        ? { agentId: q.agentId }
        : {}
      : { agentId: req.user!.id };
    const where = {
      ...agentScope,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      scheduledAt: { gte: q.from, lte: q.to },
    };
    const visits = await prisma.siteVisit.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      include: {
        project: { select: { name: true } },
        unit: { select: { unitNumber: true } },
        agent: { select: { name: true } },
      },
    });
    // Group by calendar day (UTC, YYYY-MM-DD).
    const byDate = new Map<string, typeof visits>();
    for (const v of visits) {
      const date = v.scheduledAt.toISOString().slice(0, 10);
      const list = byDate.get(date) ?? [];
      list.push(v);
      byDate.set(date, list);
    }
    const data = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, dayVisits]) => ({ date, visits: dayVisits }));
    res.json({ data });
  }),
);

// GET /api/site-visits/analytics  — visit-to-conversion summary.
router.get(
  '/analytics',
  authorize('siteVisits.analytics'),
  validate({
    query: z.object({
      agentId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as { agentId?: string; projectId?: string };
    const agentScope = hasGlobalView(req.user!)
      ? q.agentId
        ? { agentId: q.agentId }
        : {}
      : { agentId: req.user!.id };
    const where = {
      ...agentScope,
      ...(q.projectId ? { projectId: q.projectId } : {}),
    };

    const grouped = await prisma.siteVisit.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const counts: Record<string, number> = {
      SCHEDULED: 0,
      CONFIRMED: 0,
      COMPLETED: 0,
      NO_SHOW: 0,
      CANCELLED: 0,
    };
    let total = 0;
    for (const g of grouped) {
      counts[g.status] = g._count._all;
      total += g._count._all;
    }
    const completed = counts.COMPLETED;
    const completionRate = total > 0 ? Number(((completed / total) * 100).toFixed(2)) : 0;

    // Conversion: completed visits whose linked opportunity later reached WON.
    const wonVisits = await prisma.siteVisit.count({
      where: {
        ...where,
        status: 'COMPLETED',
        opportunity: { is: { stage: 'WON' } },
      },
    });
    const conversionRate = completed > 0 ? Number(((wonVisits / completed) * 100).toFixed(2)) : 0;

    res.json({
      total,
      counts,
      completionRate,
      conversion: {
        completedVisits: completed,
        wonVisits,
        conversionRate,
      },
    });
  }),
);

// POST /api/site-visits  — schedule a visit.
router.post(
  '/',
  authorize('siteVisits.create'),
  validate({ body: scheduleBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof scheduleBody>;
    // Rule: a scheduled visit cannot be in the past.
    if (b.scheduledAt.getTime() < Date.now()) {
      throw badRequest('scheduledAt cannot be in the past');
    }
    const visit = await prisma.siteVisit.create({
      data: {
        scheduledAt: b.scheduledAt,
        projectId: b.projectId,
        unitId: b.unitId,
        leadId: b.leadId,
        opportunityId: b.opportunityId,
        agentId: b.agentId ?? req.user!.id,
        transport: b.transport,
        status: VisitStatus.SCHEDULED,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'siteVisits',
      entity: 'SiteVisit',
      entityId: visit.id,
      newValue: visit,
    });
    res.status(201).json(visit);
  }),
);

// POST /api/site-visits/walk-in  — capture an unscheduled walk-in.
router.post(
  '/walk-in',
  authorize('siteVisits.create'),
  validate({ body: walkInBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof walkInBody>;
    // Walk-ins happen now and may be recorded as already COMPLETED.
    const visit = await prisma.siteVisit.create({
      data: {
        scheduledAt: new Date(),
        projectId: b.projectId,
        unitId: b.unitId,
        leadId: b.leadId,
        opportunityId: b.opportunityId,
        agentId: b.agentId ?? req.user!.id,
        transport: b.transport,
        isWalkIn: true,
        status: VisitStatus.COMPLETED,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'siteVisits',
      entity: 'SiteVisit',
      entityId: visit.id,
      newValue: visit,
    });
    res.status(201).json(visit);
  }),
);

// GET /api/site-visits/:id  — detail.
router.get(
  '/:id',
  authorize('siteVisits.read'),
  asyncHandler(async (req, res) => {
    const visit = await prisma.siteVisit.findUnique({
      where: { id: req.params.id },
      include: {
        lead: true,
        opportunity: true,
        project: true,
        unit: true,
        feedback: true,
      },
    });
    if (!visit) throw notFound('Site visit not found');
    res.json(visit);
  }),
);

// PATCH /api/site-visits/:id/status  — transition with rules.
router.patch(
  '/:id/status',
  authorize('siteVisits.update'),
  validate({ body: z.object({ status: statusEnum }) }),
  asyncHandler(async (req, res) => {
    const visit = await prisma.siteVisit.findUnique({
      where: { id: req.params.id },
      include: { feedback: true },
    });
    if (!visit) throw notFound('Site visit not found');
    const next = (req.body as { status: VisitStatus }).status;

    if (!TRANSITIONS[visit.status].includes(next)) {
      throw badRequest(`Illegal transition ${visit.status} → ${next}`);
    }
    // Cannot complete a visit without feedback on record.
    if (next === 'COMPLETED' && !visit.feedback) {
      throw badRequest('Cannot mark COMPLETED without feedback');
    }

    const updated = await prisma.siteVisit.update({
      where: { id: visit.id },
      data: { status: next },
    });

    // On NO_SHOW, auto-create a follow-up task on the linked lead (if any).
    if (next === 'NO_SHOW' && visit.leadId) {
      await prisma.leadActivity.create({
        data: {
          leadId: visit.leadId,
          type: ActivityType.TASK,
          summary: 'Follow up: site visit no-show',
          detail: `Site visit ${visit.id} marked NO_SHOW`,
          createdById: req.user!.id,
        },
      });
    }

    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.STATUS_CHANGE,
      module: 'siteVisits',
      entity: 'SiteVisit',
      entityId: visit.id,
      oldValue: { status: visit.status },
      newValue: { status: next },
    });
    res.json(updated);
  }),
);

// POST /api/site-visits/:id/feedback  — one feedback record per visit.
router.post(
  '/:id/feedback',
  authorize('siteVisits.feedback'),
  validate({ body: feedbackBody }),
  asyncHandler(async (req, res) => {
    const visit = await prisma.siteVisit.findUnique({
      where: { id: req.params.id },
      include: { feedback: true },
    });
    if (!visit) throw notFound('Site visit not found');
    if (visit.feedback) throw conflict('Feedback already exists for this visit');

    const b = req.body as z.infer<typeof feedbackBody>;
    const feedback = await prisma.visitFeedback.create({
      data: {
        visitId: visit.id,
        rating: b.rating,
        interestedUnits: b.interestedUnits,
        budgetConfirmed: b.budgetConfirmed,
        nextAction: b.nextAction,
        remarks: b.remarks,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'siteVisits',
      entity: 'VisitFeedback',
      entityId: feedback.id,
      newValue: feedback,
    });
    res.status(201).json(feedback);
  }),
);

// POST /api/site-visits/:id/reminder  — flag + dispatch a visit reminder.
// Reminder dispatch (SMS/email) is a placeholder via notifyUser for now.
router.post(
  '/:id/reminder',
  authorize('siteVisits.update'),
  asyncHandler(async (req, res) => {
    const visit = await prisma.siteVisit.findUnique({ where: { id: req.params.id } });
    if (!visit) throw notFound('Site visit not found');
    if (visit.reminderSent) throw conflict('Reminder already sent for this visit');

    const updated = await prisma.siteVisit.update({
      where: { id: visit.id },
      data: { reminderSent: true },
    });
    // Placeholder dispatch — real SMS/email scheduling wires in here later.
    await notifyUser({
      userId: visit.agentId,
      type: 'VISIT_REMINDER',
      title: 'Site visit reminder',
      body: `Reminder for site visit ${visit.id} scheduled at ${visit.scheduledAt.toISOString()}`,
      link: `/site-visits/${visit.id}`,
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'siteVisits',
      entity: 'SiteVisit',
      entityId: visit.id,
      oldValue: { reminderSent: visit.reminderSent },
      newValue: { reminderSent: true },
    });
    res.json(updated);
  }),
);

export default router;
