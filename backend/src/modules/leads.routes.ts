import { Router } from 'express';
import { z } from 'zod';
import { ActivityType, AuditAction, LeadStage, SourceChannel } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { scopeFilter, hasGlobalView } from '../middleware/scope';
import { resolveLeadRouting } from '../lib/leadRouting';

const router = Router();

const STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT_SCHEDULED',
  'NEGOTIATION',
  'CONVERTED',
  'LOST',
] as const;

const CHANNELS = [
  'GOOGLE_ADS',
  'FACEBOOK',
  'INSTAGRAM',
  'EMAIL',
  'WALK_IN',
  'REFERRAL',
  'BROKER',
  'OTHER',
] as const;

const SEGMENTS = ['RESIDENTIAL', 'COMMERCIAL', 'MIXED'] as const;

const ACTIVITY_TYPES = ['CALL', 'EMAIL', 'WHATSAPP', 'NOTE', 'TASK', 'SMS'] as const;

const leadBody = z.object({
  name: z.string().min(2),
  mobile: z.string().min(5),
  email: z.string().email().optional(),
  interestType: z.enum(SEGMENTS).optional(),
  bhk: z.string().optional(),
  budgetMinRupees: z.number().nonnegative().optional(),
  budgetMaxRupees: z.number().nonnegative().optional(),
  preferredLocation: z.string().optional(),
  city: z.string().optional(),
  projectId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  sourceId: z.string().uuid().optional(),
  sourceChannel: z.enum(CHANNELS),
  ownerId: z.string().uuid().optional(),
});

// GET /api/leads
router.get(
  '/',
  authorize('leads.read'),
  validate({ query: listQuerySchema.extend({ stage: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & { stage?: string };
    const where = {
      ...scopeFilter(req.user!, 'ownerId'),
      ...(q.stage ? { stage: q.stage as LeadStage } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { mobile: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: { campaign: { select: { name: true } }, _count: { select: { activities: true } } },
      }),
      prisma.lead.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// POST /api/leads
router.post(
  '/',
  authorize('leads.create'),
  validate({ body: leadBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof leadBody>;

    // Owner resolution: an explicit ownerId always wins. Otherwise, admins (who
    // create on behalf of the team) run the lead through the routing engine;
    // a sales agent creating their own lead keeps it.
    let ownerId = b.ownerId ?? req.user!.id;
    let routing: Awaited<ReturnType<typeof resolveLeadRouting>> = null;
    if (!b.ownerId && hasGlobalView(req.user!)) {
      routing = await resolveLeadRouting(
        { projectId: b.projectId, campaignId: b.campaignId, sourceChannel: b.sourceChannel as SourceChannel, location: b.city ?? b.preferredLocation },
        { fallbackOwnerId: req.user!.id },
      );
      if (routing) ownerId = routing.ownerId;
    }

    const lead = await prisma.lead.create({
      data: {
        name: b.name,
        mobile: b.mobile,
        email: b.email,
        interestType: b.interestType,
        bhk: b.bhk,
        budgetMinPaise: b.budgetMinRupees != null ? BigInt(Math.round(b.budgetMinRupees * 100)) : undefined,
        budgetMaxPaise: b.budgetMaxRupees != null ? BigInt(Math.round(b.budgetMaxRupees * 100)) : undefined,
        preferredLocation: b.preferredLocation,
        city: b.city,
        projectId: b.projectId,
        campaignId: b.campaignId,
        sourceId: b.sourceId,
        sourceChannel: b.sourceChannel as SourceChannel,
        ownerId,
      },
    });

    // Record an auto-routing decision on the timeline (manual owner = no note).
    if (routing && routing.outcome !== 'FALLBACK') {
      const target = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } });
      await prisma.leadActivity.create({
        data: {
          leadId: lead.id,
          type: ActivityType.NOTE,
          summary: `Auto-routed to ${target?.name ?? 'agent'}${routing.ruleName ? ` · rule "${routing.ruleName}"` : ' · default round-robin'}`,
          meta: { routing: { ownerId, outcome: routing.outcome, ruleId: routing.ruleId, ruleName: routing.ruleName, strategy: routing.strategy } } as never,
          createdById: req.user!.id,
        },
      });
    }

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'leads', entity: 'Lead', entityId: lead.id, newValue: lead });
    res.status(201).json(lead);
  }),
);

// POST /api/leads/import  — bulk import
const importBody = z.object({
  leads: z
    .array(
      z.object({
        name: z.string().min(2),
        mobile: z.string().min(5),
        email: z.string().email().optional(),
        sourceChannel: z.enum(CHANNELS),
        campaignId: z.string().uuid().optional(),
        sourceId: z.string().uuid().optional(),
        interestType: z.enum(SEGMENTS).optional(),
        bhk: z.string().optional(),
        preferredLocation: z.string().optional(),
        ownerId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});

router.post(
  '/import',
  authorize('leads.import'),
  validate({ body: importBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof importBody>;
    const result = await prisma.lead.createMany({
      data: b.leads.map((l) => ({
        name: l.name,
        mobile: l.mobile,
        email: l.email,
        sourceChannel: l.sourceChannel as SourceChannel,
        campaignId: l.campaignId,
        sourceId: l.sourceId,
        interestType: l.interestType,
        bhk: l.bhk,
        preferredLocation: l.preferredLocation,
        ownerId: l.ownerId ?? req.user!.id,
      })),
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'leads', entity: 'Lead', newValue: { imported: result.count } });
    res.status(201).json({ count: result.count });
  }),
);

// POST /api/leads/deduplicate  — find duplicate groups by mobile/email
router.post(
  '/deduplicate',
  authorize('leads.read'),
  validate({ body: z.object({ mobile: z.string().optional(), email: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const b = req.body as { mobile?: string; email?: string };

    const byMobile = await prisma.lead.groupBy({
      by: ['mobile'],
      where: b.mobile ? { mobile: b.mobile } : {},
      _count: { _all: true },
      having: { mobile: { _count: { gt: 1 } } },
    });

    const byEmail = await prisma.lead.groupBy({
      by: ['email'],
      where: b.email ? { email: b.email } : { email: { not: null } },
      _count: { _all: true },
      having: { email: { _count: { gt: 1 } } },
    });

    const mobileGroups = await Promise.all(
      byMobile.map(async (g) => ({
        key: 'mobile',
        value: g.mobile,
        count: g._count._all,
        leads: await prisma.lead.findMany({ where: { mobile: g.mobile }, orderBy: { createdAt: 'asc' } }),
      })),
    );

    const emailGroups = await Promise.all(
      byEmail
        .filter((g) => g.email != null)
        .map(async (g) => ({
          key: 'email',
          value: g.email,
          count: g._count._all,
          leads: await prisma.lead.findMany({ where: { email: g.email }, orderBy: { createdAt: 'asc' } }),
        })),
    );

    res.json({ groups: [...mobileGroups, ...emailGroups] });
  }),
);

// POST /api/leads/merge  — reassign activities to primary, delete duplicates
router.post(
  '/merge',
  authorize('leads.update'),
  validate({ body: z.object({ primaryId: z.string().uuid(), duplicateIds: z.array(z.string().uuid()).min(1) }) }),
  asyncHandler(async (req, res) => {
    const { primaryId, duplicateIds } = req.body as { primaryId: string; duplicateIds: string[] };
    if (duplicateIds.includes(primaryId)) throw badRequest('Primary lead cannot also be a duplicate');

    const primary = await prisma.lead.findUnique({ where: { id: primaryId } });
    if (!primary) throw notFound('Primary lead not found');

    const result = await prisma.$transaction(async (tx) => {
      await tx.leadActivity.updateMany({
        where: { leadId: { in: duplicateIds } },
        data: { leadId: primaryId },
      });
      const deleted = await tx.lead.deleteMany({ where: { id: { in: duplicateIds } } });
      await writeAudit({
        tx,
        userId: req.user!.id,
        action: AuditAction.DELETE,
        module: 'leads',
        entity: 'Lead',
        entityId: primaryId,
        newValue: { mergedInto: primaryId, removed: duplicateIds, deletedCount: deleted.count },
      });
      return deleted.count;
    });

    res.json({ ok: true, merged: result, primaryId });
  }),
);

// GET /api/leads/:id
router.get(
  '/:id',
  authorize('leads.read'),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { activities: { orderBy: { createdAt: 'desc' } }, campaign: true },
    });
    if (!lead) throw notFound('Lead not found');
    res.json(lead);
  }),
);

// PUT /api/leads/:id
router.put(
  '/:id',
  authorize('leads.update'),
  validate({ body: leadBody.partial() }),
  asyncHandler(async (req, res) => {
    const before = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Lead not found');
    const { budgetMinRupees, budgetMaxRupees, ownerId, sourceChannel, ...rest } = req.body as Partial<z.infer<typeof leadBody>>;
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        sourceChannel: sourceChannel ? (sourceChannel as SourceChannel) : undefined,
        ownerId: ownerId ?? undefined,
        budgetMinPaise: budgetMinRupees != null ? BigInt(Math.round(budgetMinRupees * 100)) : undefined,
        budgetMaxPaise: budgetMaxRupees != null ? BigInt(Math.round(budgetMaxRupees * 100)) : undefined,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'leads', entity: 'Lead', entityId: lead.id, oldValue: before, newValue: lead });
    res.json(lead);
  }),
);

// PATCH /api/leads/:id/stage
router.patch(
  '/:id/stage',
  authorize('leads.update'),
  validate({ body: z.object({ stage: z.enum(STAGES), lostReason: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const { stage, lostReason } = req.body as { stage: LeadStage; lostReason?: string };
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) throw notFound('Lead not found');
    if (stage === LeadStage.LOST && !lostReason) throw badRequest('lostReason is required when marking a lead LOST');

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.lead.update({
        where: { id: lead.id },
        data: {
          stage,
          lostReason: stage === LeadStage.LOST ? lostReason : lead.lostReason,
          firstContactAt:
            stage === LeadStage.CONTACTED && lead.firstContactAt == null ? new Date() : lead.firstContactAt,
        },
      });
      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          type: ActivityType.STAGE_CHANGE,
          summary: `Stage ${lead.stage} → ${stage}`,
          detail: stage === LeadStage.LOST ? lostReason : undefined,
          createdById: req.user!.id,
        },
      });
      await writeAudit({
        tx,
        userId: req.user!.id,
        action: AuditAction.STATUS_CHANGE,
        module: 'leads',
        entity: 'Lead',
        entityId: lead.id,
        oldValue: { stage: lead.stage },
        newValue: { stage },
      });
      return next;
    });

    res.json(updated);
  }),
);

// POST /api/leads/:id/activities
router.post(
  '/:id/activities',
  authorize('leads.update'),
  validate({
    body: z.object({
      type: z.enum(ACTIVITY_TYPES),
      summary: z.string().min(1),
      detail: z.string().optional(),
      meta: z.record(z.unknown()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) throw notFound('Lead not found');
    const b = req.body as { type: ActivityType; summary: string; detail?: string; meta?: Record<string, unknown> };
    const activity = await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: b.type as ActivityType,
        summary: b.summary,
        detail: b.detail,
        meta: b.meta as never,
        createdById: req.user!.id,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'leads', entity: 'LeadActivity', entityId: activity.id, newValue: activity });
    res.status(201).json(activity);
  }),
);

// GET /api/leads/:id/timeline
router.get(
  '/:id/timeline',
  authorize('leads.read'),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) throw notFound('Lead not found');
    const activities = await prisma.leadActivity.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: activities });
  }),
);

// POST /api/leads/:id/convert
//
// Salesforce-style conversion: the lead always becomes an Account (create a new
// one from the person's name, or link an existing one). Creating an Opportunity
// is OPTIONAL — only when a projectId is supplied (an Opportunity always belongs
// to a project). So a lead can be converted to just an Account, no project.
const convertBody = z.object({
  // Account — choose an existing one, or create a new person account.
  accountId: z.string().uuid().optional(), // when set: link this existing account
  salutation: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  // Opportunity (optional) — only created when a project is chosen.
  projectId: z.string().uuid().optional(),
  opportunityName: z.string().optional(),
  name: z.string().optional(), // legacy alias for opportunityName
});

router.post(
  '/:id/convert',
  authorize('leads.convert'),
  validate({ body: convertBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof convertBody>;
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) throw notFound('Lead not found');
    if (lead.opportunityId) throw conflict('Lead already has an active opportunity');
    if (lead.stage === LeadStage.CONVERTED) throw conflict('Lead is already converted');

    // Compose the new account/contact name from the salutation + first/last name
    // captured on the convert form, falling back to the lead's own name.
    const personName =
      [b.salutation, b.firstName, b.lastName].map((s) => s?.trim()).filter(Boolean).join(' ').trim() || lead.name;

    const result = await prisma.$transaction(async (tx) => {
      let account;
      if (b.accountId) {
        // Choose Existing Account: link it and add the lead's person as a contact.
        account = await tx.account.findUnique({ where: { id: b.accountId } });
        if (!account) throw badRequest('Selected account not found');
        await tx.contact.create({
          data: { accountId: account.id, name: lead.name, mobile: lead.mobile, email: lead.email, isPrimary: false },
        });
      } else {
        // Create New Account (person account) with a primary contact.
        account = await tx.account.create({
          data: {
            name: personName,
            type: 'INDIVIDUAL',
            ownerId: lead.ownerId,
            contacts: { create: { name: personName, mobile: lead.mobile, email: lead.email, isPrimary: true } },
          },
        });
      }

      // Opportunity is optional — only when a project is selected.
      let opportunity = null;
      if (b.projectId) {
        opportunity = await tx.opportunity.create({
          data: {
            name: b.opportunityName ?? b.name ?? `${lead.name} — ${lead.bhk ?? 'Opportunity'}`,
            accountId: account.id,
            projectId: b.projectId,
            stage: 'PROSPECT',
            probability: 10,
            ownerId: lead.ownerId,
            campaignId: lead.campaignId,
          },
        });
      }

      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          stage: LeadStage.CONVERTED,
          convertedAt: new Date(),
          accountId: account.id,
          opportunityId: opportunity?.id,
        },
      });

      await writeAudit({
        tx,
        userId: req.user!.id,
        action: AuditAction.STATUS_CHANGE,
        module: 'leads',
        entity: 'Lead',
        entityId: lead.id,
        oldValue: { stage: lead.stage },
        newValue: { stage: LeadStage.CONVERTED, accountId: account.id, opportunityId: opportunity?.id ?? null },
      });

      return { account, opportunity, lead: updatedLead };
    });

    res.status(201).json(result);
  }),
);

// POST /api/leads/:id/assign
router.post(
  '/:id/assign',
  authorize('leads.assign'),
  validate({ body: z.object({ ownerId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { ownerId } = req.body as { ownerId: string };
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) throw notFound('Lead not found');
    const owner = await prisma.user.findUnique({ where: { id: ownerId } });
    if (!owner) throw badRequest('Target owner not found');

    const updated = await prisma.lead.update({ where: { id: lead.id }, data: { ownerId } });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'leads',
      entity: 'Lead',
      entityId: lead.id,
      oldValue: { ownerId: lead.ownerId },
      newValue: { ownerId },
    });
    res.json(updated);
  }),
);

export default router;
