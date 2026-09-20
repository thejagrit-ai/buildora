import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, CampaignStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { notifyUser } from '../lib/notify';

const router = Router();

const campaignBody = z.object({
  name: z.string().min(2),
  type: z.enum(['DIGITAL', 'PRINT', 'EVENTS', 'REFERRAL', 'CHANNEL_PARTNER']),
  segment: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED']),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  budgetRupees: z.number().nonnegative().default(0),
  projectId: z.string().uuid().optional(),
});

// GET /api/campaigns
router.get(
  '/',
  authorize('campaigns.read'),
  validate({ query: listQuerySchema.extend({ status: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & { status?: string };
    const where = {
      ...(q.status ? { status: q.status as CampaignStatus } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: { project: { select: { name: true } }, _count: { select: { leads: true } } },
      }),
      prisma.campaign.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// POST /api/campaigns
router.post(
  '/',
  authorize('campaigns.create'),
  validate({ body: campaignBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof campaignBody>;
    const campaign = await prisma.campaign.create({
      data: {
        name: b.name,
        type: b.type,
        segment: b.segment,
        startDate: b.startDate,
        endDate: b.endDate,
        budgetPaise: BigInt(Math.round(b.budgetRupees * 100)),
        projectId: b.projectId,
        ownerId: req.user!.id,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'campaigns', entity: 'Campaign', entityId: campaign.id, newValue: campaign });
    res.status(201).json(campaign);
  }),
);

// GET /api/campaigns/:id
router.get(
  '/:id',
  authorize('campaigns.read'),
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: { sources: true, project: true, owner: { select: { name: true } } },
    });
    if (!campaign) throw notFound('Campaign not found');
    res.json(campaign);
  }),
);

// PUT /api/campaigns/:id
router.put(
  '/:id',
  authorize('campaigns.update'),
  validate({ body: campaignBody.partial() }),
  asyncHandler(async (req, res) => {
    const before = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Campaign not found');
    const { budgetRupees, ...rest } = req.body as Partial<z.infer<typeof campaignBody>>;
    const campaign = await prisma.campaign.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        budgetPaise: budgetRupees != null ? BigInt(Math.round(budgetRupees * 100)) : undefined,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'campaigns', entity: 'Campaign', entityId: campaign.id, oldValue: before, newValue: campaign });
    res.json(campaign);
  }),
);

// PATCH /api/campaigns/:id/status
const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

router.patch(
  '/:id/status',
  authorize('campaigns.update', 'campaigns.archive'),
  validate({ body: z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']) }) }),
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) throw notFound('Campaign not found');
    const next = req.body.status as CampaignStatus;
    if (!TRANSITIONS[campaign.status].includes(next)) {
      throw badRequest(`Illegal transition ${campaign.status} → ${next}`);
    }
    const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: { status: next } });
    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'campaigns', entity: 'Campaign', entityId: campaign.id, oldValue: { status: campaign.status }, newValue: { status: next } });
    res.json(updated);
  }),
);

// POST /api/campaigns/:id/clone  — campaign cloning for recurring campaigns
router.post(
  '/:id/clone',
  authorize('campaigns.create'),
  asyncHandler(async (req, res) => {
    const src = await prisma.campaign.findUnique({ where: { id: req.params.id }, include: { sources: true } });
    if (!src) throw notFound('Campaign not found');
    const clone = await prisma.campaign.create({
      data: {
        name: `${src.name} (Copy)`,
        type: src.type,
        segment: src.segment,
        startDate: new Date(),
        budgetPaise: src.budgetPaise,
        projectId: src.projectId,
        ownerId: req.user!.id,
        status: 'DRAFT',
        sources: {
          create: src.sources.map((s) => ({
            channel: s.channel,
            utmSource: s.utmSource,
            utmMedium: s.utmMedium,
            utmCampaign: s.utmCampaign,
          })),
        },
      },
    });
    res.status(201).json(clone);
  }),
);

// GET /api/campaigns/:id/leads
router.get(
  '/:id/leads',
  authorize('campaigns.read'),
  asyncHandler(async (req, res) => {
    const leads = await prisma.lead.findMany({
      where: { campaignId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: leads });
  }),
);

// GET /api/campaigns/:id/analytics  — leads, CPL, conversion, ROI
router.get(
  '/:id/analytics',
  authorize('campaigns.analytics'),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw notFound('Campaign not found');

    const [leadCount, convertedCount, oppCount, wonBookings] = await Promise.all([
      prisma.lead.count({ where: { campaignId: id } }),
      prisma.lead.count({ where: { campaignId: id, stage: 'CONVERTED' } }),
      prisma.opportunity.count({ where: { campaignId: id } }),
      prisma.opportunity.findMany({
        where: { campaignId: id, stage: 'WON' },
        select: { dealValuePaise: true },
      }),
    ]);

    const revenuePaise = wonBookings.reduce((sum, o) => sum + o.dealValuePaise, 0n);
    const spend = campaign.actualSpendPaise > 0n ? campaign.actualSpendPaise : campaign.budgetPaise;
    const cplPaise = leadCount > 0 ? spend / BigInt(leadCount) : 0n;
    const conversionRate = leadCount > 0 ? (oppCount / leadCount) * 100 : 0;
    const roi =
      spend > 0n ? Number(((revenuePaise - spend) * 10000n) / spend) / 100 : 0;

    res.json({
      leadCount,
      convertedCount,
      opportunityCount: oppCount,
      conversionRate: Number(conversionRate.toFixed(2)),
      costPerLeadPaise: cplPaise.toString(),
      revenuePaise: revenuePaise.toString(),
      spendPaise: spend.toString(),
      roiPercent: roi,
    });
  }),
);

// POST /api/campaigns/:id/spend  — record actual spend; budget alerts at 80/100%
router.post(
  '/:id/spend',
  authorize('campaigns.update'),
  validate({ body: z.object({ amountRupees: z.number().positive() }) }),
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) throw notFound('Campaign not found');
    const add = BigInt(Math.round(req.body.amountRupees * 100));
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { actualSpendPaise: campaign.actualSpendPaise + add },
    });

    if (campaign.budgetPaise > 0n) {
      const pct = Number((updated.actualSpendPaise * 100n) / campaign.budgetPaise);
      const prevPct = Number((campaign.actualSpendPaise * 100n) / campaign.budgetPaise);
      for (const threshold of [80, 100]) {
        if (prevPct < threshold && pct >= threshold) {
          await notifyUser({
            userId: campaign.ownerId,
            type: 'BUDGET_ALERT',
            title: `Campaign budget ${threshold}% reached`,
            body: `"${campaign.name}" has spent ${pct}% of its budget.`,
            link: `/campaigns/${campaign.id}`,
          });
        }
      }
    }
    res.json(updated);
  }),
);

// Business rule: cannot delete a campaign with leads — archive instead.
router.delete(
  '/:id',
  authorize('campaigns.archive'),
  asyncHandler(async (req, res) => {
    const count = await prisma.lead.count({ where: { campaignId: req.params.id } });
    if (count > 0) throw conflict('Campaign has leads; archive it instead of deleting');
    await prisma.campaign.delete({ where: { id: req.params.id } });
    await writeAudit({ userId: req.user!.id, action: AuditAction.DELETE, module: 'campaigns', entity: 'Campaign', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

export default router;
