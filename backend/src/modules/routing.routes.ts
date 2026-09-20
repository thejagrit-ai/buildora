import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, RoutingStrategy, SourceChannel } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { badRequest, notFound } from '../lib/errors';
import { explainLeadRouting } from '../lib/leadRouting';

/**
 * Lead-routing admin API. Lets a CRM Admin build the ordered rule set that
 * decides which salesperson (or team) receives each incoming lead, plus a
 * dry-run "test" tool. The engine itself lives in lib/leadRouting.ts and is
 * invoked from the lead-create paths.
 */
const router = Router();

const CHANNELS = [
  'GOOGLE_ADS', 'FACEBOOK', 'INSTAGRAM', 'EMAIL', 'WALK_IN', 'REFERRAL', 'BROKER', 'OTHER',
] as const;
const STRATEGIES = ['SPECIFIC_USER', 'ROUND_ROBIN'] as const;

const ruleBody = z.object({
  name: z.string().min(2),
  description: z.string().max(500).optional(),
  active: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
  campaignId: z.string().uuid().nullable().optional(),
  sourceChannel: z.enum(CHANNELS).nullable().optional(),
  locations: z.array(z.string().min(1)).max(50).optional(),
  strategy: z.enum(STRATEGIES),
  targetUserId: z.string().uuid().nullable().optional(),
  memberIds: z.array(z.string().uuid()).max(100).optional(),
});

type RuleInput = z.infer<typeof ruleBody>;

// The target shape depends on the strategy; enforce it after schema validation.
function assertStrategyTarget(b: RuleInput) {
  if (b.strategy === 'SPECIFIC_USER' && !b.targetUserId) {
    throw badRequest('targetUserId is required for the SPECIFIC_USER strategy');
  }
  if (b.strategy === 'ROUND_ROBIN' && (!b.memberIds || b.memberIds.length === 0)) {
    throw badRequest('memberIds must contain at least one user for the ROUND_ROBIN strategy');
  }
}

// Build display names for the project / campaign / users a rule (or set of
// rules) references, in as few queries as possible.
async function nameMaps(rules: { projectId: string | null; campaignId: string | null; targetUserId: string | null; memberIds: string[] }[]) {
  const projectIds = new Set<string>();
  const campaignIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of rules) {
    if (r.projectId) projectIds.add(r.projectId);
    if (r.campaignId) campaignIds.add(r.campaignId);
    if (r.targetUserId) userIds.add(r.targetUserId);
    r.memberIds.forEach((id) => userIds.add(id));
  }
  const [projects, campaigns, users] = await Promise.all([
    projectIds.size ? prisma.project.findMany({ where: { id: { in: [...projectIds] } }, select: { id: true, name: true } }) : [],
    campaignIds.size ? prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true } }) : [],
    userIds.size ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, isActive: true } }) : [],
  ]);
  return {
    project: new Map(projects.map((p) => [p.id, p.name])),
    campaign: new Map(campaigns.map((c) => [c.id, c.name])),
    user: new Map(users.map((u) => [u.id, u])),
  };
}

function enrichRule(rule: any, maps: Awaited<ReturnType<typeof nameMaps>>) {
  return {
    ...rule,
    projectName: rule.projectId ? maps.project.get(rule.projectId) ?? null : null,
    campaignName: rule.campaignId ? maps.campaign.get(rule.campaignId) ?? null : null,
    targetUser: rule.targetUserId ? maps.user.get(rule.targetUserId) ?? null : null,
    members: rule.memberIds.map((id: string) => maps.user.get(id) ?? { id, name: '(removed user)', isActive: false }),
  };
}

// Reject conditions / targets that point at rows that don't exist, so rules are
// never silently dead.
async function assertReferencesExist(b: RuleInput) {
  if (b.projectId) {
    const p = await prisma.project.findUnique({ where: { id: b.projectId }, select: { id: true } });
    if (!p) throw badRequest('projectId does not exist');
  }
  if (b.campaignId) {
    const c = await prisma.campaign.findUnique({ where: { id: b.campaignId }, select: { id: true } });
    if (!c) throw badRequest('campaignId does not exist');
  }
  const userIds = [b.targetUserId, ...(b.memberIds ?? [])].filter(Boolean) as string[];
  if (userIds.length) {
    const found = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
    if (found.length !== new Set(userIds).size) throw badRequest('One or more target users do not exist');
  }
}

// GET /api/routing/rules
router.get(
  '/rules',
  authorize('leads.routing'),
  asyncHandler(async (_req, res) => {
    const rules = await prisma.leadRoutingRule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
    const maps = await nameMaps(rules);
    res.json({ data: rules.map((r) => enrichRule(r, maps)) });
  }),
);

// POST /api/routing/rules
router.post(
  '/rules',
  authorize('leads.routing'),
  validate({ body: ruleBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as RuleInput;
    assertStrategyTarget(b);
    await assertReferencesExist(b);

    const last = await prisma.leadRoutingRule.findFirst({ orderBy: { priority: 'desc' }, select: { priority: true } });
    const rule = await prisma.leadRoutingRule.create({
      data: {
        name: b.name,
        description: b.description,
        active: b.active ?? true,
        priority: (last?.priority ?? -1) + 1,
        projectId: b.projectId ?? null,
        campaignId: b.campaignId ?? null,
        sourceChannel: (b.sourceChannel ?? null) as SourceChannel | null,
        locations: b.locations ?? [],
        strategy: b.strategy as RoutingStrategy,
        targetUserId: b.strategy === 'SPECIFIC_USER' ? b.targetUserId ?? null : null,
        memberIds: b.strategy === 'ROUND_ROBIN' ? b.memberIds ?? [] : [],
        createdById: req.user!.id,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'routing', entity: 'LeadRoutingRule', entityId: rule.id, newValue: rule });
    res.status(201).json(rule);
  }),
);

// PUT /api/routing/rules/reorder  — set priority from array order
router.put(
  '/rules/reorder',
  authorize('leads.routing'),
  validate({ body: z.object({ ids: z.array(z.string().uuid()).min(1) }) }),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] };
    await prisma.$transaction(ids.map((id, i) => prisma.leadRoutingRule.update({ where: { id }, data: { priority: i } })));
    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'routing', entity: 'LeadRoutingRule', newValue: { reordered: ids } });
    res.json({ ok: true });
  }),
);

// PUT /api/routing/rules/:id
router.put(
  '/rules/:id',
  authorize('leads.routing'),
  validate({ body: ruleBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as RuleInput;
    assertStrategyTarget(b);
    const before = await prisma.leadRoutingRule.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Routing rule not found');
    await assertReferencesExist(b);

    const rule = await prisma.leadRoutingRule.update({
      where: { id: req.params.id },
      data: {
        name: b.name,
        description: b.description ?? null,
        active: b.active ?? before.active,
        projectId: b.projectId ?? null,
        campaignId: b.campaignId ?? null,
        sourceChannel: (b.sourceChannel ?? null) as SourceChannel | null,
        locations: b.locations ?? [],
        strategy: b.strategy as RoutingStrategy,
        targetUserId: b.strategy === 'SPECIFIC_USER' ? b.targetUserId ?? null : null,
        memberIds: b.strategy === 'ROUND_ROBIN' ? b.memberIds ?? [] : [],
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'routing', entity: 'LeadRoutingRule', entityId: rule.id, oldValue: before, newValue: rule });
    res.json(rule);
  }),
);

// DELETE /api/routing/rules/:id
router.delete(
  '/rules/:id',
  authorize('leads.routing'),
  asyncHandler(async (req, res) => {
    const before = await prisma.leadRoutingRule.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Routing rule not found');
    await prisma.leadRoutingRule.delete({ where: { id: req.params.id } });
    await writeAudit({ userId: req.user!.id, action: AuditAction.DELETE, module: 'routing', entity: 'LeadRoutingRule', entityId: before.id, oldValue: before });
    res.json({ ok: true });
  }),
);

// POST /api/routing/test  — dry-run the engine against a hypothetical lead
router.post(
  '/test',
  authorize('leads.routing'),
  validate({
    body: z.object({
      projectId: z.string().uuid().nullable().optional(),
      campaignId: z.string().uuid().nullable().optional(),
      sourceChannel: z.enum(CHANNELS).nullable().optional(),
      location: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body as { projectId?: string | null; campaignId?: string | null; sourceChannel?: string | null; location?: string };
    const { evaluations, result } = await explainLeadRouting({
      projectId: b.projectId ?? null,
      campaignId: b.campaignId ?? null,
      sourceChannel: (b.sourceChannel ?? null) as SourceChannel | null,
      location: b.location ?? null,
    });

    const owner = result ? await prisma.user.findUnique({ where: { id: result.ownerId }, select: { id: true, name: true, email: true } }) : null;
    res.json({ evaluations, result: result ? { ...result, owner } : null });
  }),
);

export default router;
