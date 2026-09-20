import { Router } from 'express';
import { z } from 'zod';
import { ActivityType, AuditAction, OpportunityStage } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { scopeFilter } from '../middleware/scope';

const router = Router();

// Stage → default probability (%). Applied on create and on every stage change.
const STAGE_PROBABILITY: Record<OpportunityStage, number> = {
  PROSPECT: 10,
  QUALIFIED: 25,
  SITE_VISIT_DONE: 40,
  NEGOTIATION: 60,
  VERBAL_COMMIT: 80,
  WON: 100,
  LOST: 0,
};

// Stages that are considered "open" (not closed-won / closed-lost).
const OPEN_STAGES: OpportunityStage[] = [
  'PROSPECT',
  'QUALIFIED',
  'SITE_VISIT_DONE',
  'NEGOTIATION',
  'VERBAL_COMMIT',
];

const stageEnum = z.enum([
  'PROSPECT',
  'QUALIFIED',
  'SITE_VISIT_DONE',
  'NEGOTIATION',
  'VERBAL_COMMIT',
  'WON',
  'LOST',
]);

/**
 * Soft-block check: a single inventory unit should not be actively pursued by
 * more than one open opportunity. If another OPEN opportunity (stage not
 * WON/LOST) already references `unitId`, we raise a 409 conflict — UNLESS the
 * caller passes `override: true`. Managers (global-view roles) are the intended
 * users of the override flag; the override itself is honoured for anyone who
 * sets it, but the UI only exposes it to managers.
 */
async function assertUnitNotDoubleBooked(
  unitId: string,
  override: boolean,
  excludeOpportunityId?: string,
): Promise<void> {
  if (override) return;
  const clash = await prisma.opportunity.findFirst({
    where: {
      unitId,
      stage: { in: OPEN_STAGES },
      ...(excludeOpportunityId ? { id: { not: excludeOpportunityId } } : {}),
    },
    select: { id: true, name: true },
  });
  if (clash) {
    throw conflict(
      `Unit already pursued by open opportunity "${clash.name}" (${clash.id}); pass override:true to proceed`,
    );
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const opportunityBody = z.object({
  name: z.string().min(2),
  accountId: z.string().uuid(),
  projectId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  stage: stageEnum.optional(),
  expectedCloseAt: z.coerce.date().optional(),
  dealValueRupees: z.number().nonnegative().default(0),
  ownerId: z.string().uuid().optional(),
  coOwnerId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  competitorNotes: z.string().optional(),
  override: z.boolean().optional(),
});

const activityBody = z.object({
  type: z.enum(['CALL', 'EMAIL', 'WHATSAPP', 'NOTE', 'STAGE_CHANGE', 'TASK', 'SMS']),
  summary: z.string().min(1),
  detail: z.string().optional(),
});

// GET /api/opportunities  — paginated list
router.get(
  '/',
  authorize('opportunities.read'),
  validate({
    query: listQuerySchema.extend({
      stage: stageEnum.optional(),
      projectId: z.string().uuid().optional(),
      accountId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & {
      stage?: OpportunityStage;
      projectId?: string;
      accountId?: string;
    };
    const where = {
      ...scopeFilter(req.user!, 'ownerId'),
      ...(q.stage ? { stage: q.stage } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.opportunity.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: {
          account: { select: { name: true } },
          project: { select: { name: true } },
          unit: { select: { unitNumber: true } },
        },
      }),
      prisma.opportunity.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// GET /api/opportunities/stale  — opportunities idle longer than `days` days.
// Defined before /:id so the literal path is not captured by the id param.
router.get(
  '/stale',
  authorize('opportunities.read'),
  validate({ query: z.object({ days: z.coerce.number().int().min(1).default(14) }) }),
  asyncHandler(async (req, res) => {
    const days = (req.query as never as { days: number }).days;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = {
      ...scopeFilter(req.user!, 'ownerId'),
      stage: { in: OPEN_STAGES },
      OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null }],
    };
    const data = await prisma.opportunity.findMany({
      where,
      orderBy: { lastActivityAt: 'asc' },
      include: {
        account: { select: { name: true } },
        project: { select: { name: true } },
      },
    });
    res.json({ data, meta: { days, cutoff } });
  }),
);

// GET /api/opportunities/pipeline  — count + deal value summed per stage.
router.get(
  '/pipeline',
  authorize('opportunities.read', 'opportunities.forecast'),
  asyncHandler(async (req, res) => {
    const where = scopeFilter(req.user!, 'ownerId');
    const grouped = await prisma.opportunity.groupBy({
      by: ['stage'],
      where,
      _count: { _all: true },
      _sum: { dealValuePaise: true },
    });
    const byStage = new Map(grouped.map((g) => [g.stage, g]));
    // Emit every stage (open + closed) in canonical order, zero-filling gaps.
    const allStages: OpportunityStage[] = [...OPEN_STAGES, 'WON', 'LOST'];
    const data = allStages.map((stage) => {
      const g = byStage.get(stage);
      return {
        stage,
        count: g?._count._all ?? 0,
        valuePaise: (g?._sum.dealValuePaise ?? 0n).toString(),
      };
    });
    res.json({ data });
  }),
);

// GET /api/opportunities/forecast  — weighted pipeline by expected-close month.
router.get(
  '/forecast',
  authorize('opportunities.forecast'),
  asyncHandler(async (req, res) => {
    const where = {
      ...scopeFilter(req.user!, 'ownerId'),
      stage: { in: OPEN_STAGES }, // open opps only (excludes WON/LOST)
      expectedCloseAt: { not: null },
    };
    const opps = await prisma.opportunity.findMany({
      where,
      select: { expectedCloseAt: true, dealValuePaise: true, probability: true },
    });

    type Bucket = { month: string; weightedPaise: bigint; rawPaise: bigint; count: number };
    const buckets = new Map<string, Bucket>();
    for (const o of opps) {
      if (!o.expectedCloseAt) continue;
      const d = o.expectedCloseAt;
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const b = buckets.get(month) ?? { month, weightedPaise: 0n, rawPaise: 0n, count: 0 };
      // weighted = dealValue * probability / 100 (integer paise math)
      b.weightedPaise += (o.dealValuePaise * BigInt(o.probability)) / 100n;
      b.rawPaise += o.dealValuePaise;
      b.count += 1;
      buckets.set(month, b);
    }
    const data = [...buckets.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((b) => ({
        month: b.month,
        weightedPaise: b.weightedPaise.toString(),
        rawPaise: b.rawPaise.toString(),
        count: b.count,
      }));
    res.json({ data });
  }),
);

// POST /api/opportunities  — create
router.post(
  '/',
  authorize('opportunities.create'),
  validate({ body: opportunityBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof opportunityBody>;
    const stage: OpportunityStage = b.stage ?? 'PROSPECT';

    if (b.unitId) {
      await assertUnitNotDoubleBooked(b.unitId, b.override === true);
    }

    const opportunity = await prisma.opportunity.create({
      data: {
        name: b.name,
        accountId: b.accountId,
        projectId: b.projectId,
        unitId: b.unitId,
        stage,
        probability: STAGE_PROBABILITY[stage],
        expectedCloseAt: b.expectedCloseAt,
        dealValuePaise: BigInt(Math.round(b.dealValueRupees * 100)),
        ownerId: b.ownerId ?? req.user!.id,
        coOwnerId: b.coOwnerId,
        campaignId: b.campaignId,
        competitorNotes: b.competitorNotes,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'opportunities',
      entity: 'Opportunity',
      entityId: opportunity.id,
      newValue: opportunity,
    });
    res.status(201).json(opportunity);
  }),
);

// GET /api/opportunities/:id  — detail
router.get(
  '/:id',
  authorize('opportunities.read'),
  asyncHandler(async (req, res) => {
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: req.params.id },
      include: {
        account: true,
        project: true,
        unit: true,
        activities: { orderBy: { createdAt: 'desc' } },
        quotations: true,
      },
    });
    if (!opportunity) throw notFound('Opportunity not found');
    res.json(opportunity);
  }),
);

// PUT /api/opportunities/:id  — update
router.put(
  '/:id',
  authorize('opportunities.update'),
  validate({ body: opportunityBody.partial() }),
  asyncHandler(async (req, res) => {
    const before = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Opportunity not found');
    const b = req.body as Partial<z.infer<typeof opportunityBody>>;

    // Re-run the soft-block check if a (different) unit is being assigned.
    if (b.unitId && b.unitId !== before.unitId) {
      await assertUnitNotDoubleBooked(b.unitId, b.override === true, before.id);
    }

    const opportunity = await prisma.opportunity.update({
      where: { id: before.id },
      data: {
        name: b.name,
        accountId: b.accountId,
        projectId: b.projectId,
        unitId: b.unitId,
        expectedCloseAt: b.expectedCloseAt,
        dealValuePaise:
          b.dealValueRupees != null ? BigInt(Math.round(b.dealValueRupees * 100)) : undefined,
        ownerId: b.ownerId,
        coOwnerId: b.coOwnerId,
        campaignId: b.campaignId,
        competitorNotes: b.competitorNotes,
        // Stage is intentionally NOT updatable here — use PATCH /:id/stage.
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'opportunities',
      entity: 'Opportunity',
      entityId: opportunity.id,
      oldValue: before,
      newValue: opportunity,
    });
    res.json(opportunity);
  }),
);

// PATCH /api/opportunities/:id/stage  — stage transition with rules.
router.patch(
  '/:id/stage',
  authorize('opportunities.stage'),
  validate({
    body: z.object({
      stage: stageEnum,
      lostReason: z.string().optional(),
      lostCompetitor: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) throw notFound('Opportunity not found');
    const body = req.body as { stage: OpportunityStage; lostReason?: string; lostCompetitor?: string };
    const next = body.stage;

    // Closing rules.
    if (next === 'WON') {
      const booking = await prisma.booking.findUnique({
        where: { opportunityId: opportunity.id },
        select: { id: true },
      });
      if (!booking) throw badRequest('Won requires a booking');
    }
    if (next === 'LOST' && !body.lostReason) {
      throw badRequest('Lost requires a lostReason');
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const opp = await tx.opportunity.update({
        where: { id: opportunity.id },
        data: {
          stage: next,
          probability: STAGE_PROBABILITY[next],
          lastActivityAt: now,
          lostReason: next === 'LOST' ? body.lostReason : opportunity.lostReason,
          lostCompetitor: next === 'LOST' ? body.lostCompetitor : opportunity.lostCompetitor,
        },
      });
      await tx.opportunityActivity.create({
        data: {
          opportunityId: opportunity.id,
          type: ActivityType.STAGE_CHANGE,
          summary: `Stage ${opportunity.stage} → ${next}`,
          detail: next === 'LOST' ? body.lostReason : undefined,
          createdById: req.user!.id,
        },
      });
      return opp;
    });

    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.STATUS_CHANGE,
      module: 'opportunities',
      entity: 'Opportunity',
      entityId: opportunity.id,
      oldValue: { stage: opportunity.stage, probability: opportunity.probability },
      newValue: { stage: updated.stage, probability: updated.probability },
    });
    res.json(updated);
  }),
);

// POST /api/opportunities/:id/activities  — log an activity, touch lastActivityAt.
router.post(
  '/:id/activities',
  authorize('opportunities.update'),
  validate({ body: activityBody }),
  asyncHandler(async (req, res) => {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) throw notFound('Opportunity not found');
    const b = req.body as z.infer<typeof activityBody>;
    const now = new Date();

    const activity = await prisma.$transaction(async (tx) => {
      const created = await tx.opportunityActivity.create({
        data: {
          opportunityId: opportunity.id,
          type: b.type as ActivityType,
          summary: b.summary,
          detail: b.detail,
          createdById: req.user!.id,
        },
      });
      await tx.opportunity.update({
        where: { id: opportunity.id },
        data: { lastActivityAt: now },
      });
      return created;
    });

    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'opportunities',
      entity: 'OpportunityActivity',
      entityId: activity.id,
      newValue: activity,
    });
    res.status(201).json(activity);
  }),
);

export default router;
