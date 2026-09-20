import { Router } from 'express';
import { z } from 'zod';
import { AccountType, ActivityType, AuditAction, EmpanelmentStatus, KycStatus, LeadStage, SourceChannel } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { env } from '../config/env';
import { badRequest, unauthorized } from '../lib/errors';
import { resolveLeadRouting } from '../lib/leadRouting';
import { tenantContext } from '../lib/tenantContext';

/**
 * Partner intake API — server-to-server endpoints for the Channel Partner
 * (broker) portal. NOT behind the JWT user auth; gated by a shared API key
 * (PARTNER_API_KEY) sent in the `x-api-key` header. Submissions are mapped into
 * native CRM records (Leads, Channel-Partner Accounts).
 */
const router = Router();

// API-key gate.
router.use(async (req, _res, next) => {
  if (!env.PARTNER_API_KEY) {
    return next(badRequest('Partner intake is not configured (PARTNER_API_KEY unset)'));
  }
  if (!env.PARTNER_ORGANIZATION_ID) {
    return next(badRequest('Partner intake is not configured (PARTNER_ORGANIZATION_ID unset)'));
  }
  const key = req.header('x-api-key');
  if (!key || key !== env.PARTNER_API_KEY) return next(unauthorized('Invalid partner API key'));
  const owner = await prisma.user.findFirst({
    where: { isActive: true, memberships: { some: { organizationId: env.PARTNER_ORGANIZATION_ID, status: 'ACTIVE' } } },
    include: { memberships: { where: { organizationId: env.PARTNER_ORGANIZATION_ID, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, take: 1 } },
    orderBy: { createdAt: 'asc' },
  });
  const membership = owner?.memberships[0];
  if (!owner || !membership) return next(badRequest('No active partner intake owner is configured'));
  tenantContext.run({ organizationId: env.PARTNER_ORGANIZATION_ID, membershipId: membership.id, userId: owner.id }, next);
});

// Partner submissions have no logged-in user, so records need a CRM owner.
// Prefer an active sales agent (so leads land in someone's queue); else any
// active user.
async function resolveIntakeOwner(): Promise<string> {
  const agent = await prisma.user.findFirst({
    where: { isActive: true, role: { name: 'SALES_AGENT' }, memberships: { some: { organizationId: env.PARTNER_ORGANIZATION_ID, status: 'ACTIVE' } } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (agent) return agent.id;
  const any = await prisma.user.findFirst({
    where: { isActive: true, memberships: { some: { organizationId: env.PARTNER_ORGANIZATION_ID, status: 'ACTIVE' } } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!any) throw badRequest('No active user available to own the record');
  return any.id;
}

// Map the broker portal's budget picklist labels to a [min, max] rupee range.
const BUDGET_RANGES: Record<string, [number | null, number | null]> = {
  'Below 50 Lakhs': [null, 5_000_000],
  '50 Lakhs - 1 Crore': [5_000_000, 10_000_000],
  '1 Crore - 2 Crore': [10_000_000, 20_000_000],
  '2 Crore - 5 Crore': [20_000_000, 50_000_000],
  'Above 5 Crore': [50_000_000, null],
};

const toPaise = (rupees: number | null) => (rupees != null ? BigInt(Math.round(rupees * 100)) : undefined);

// ── Lead intake ────────────────────────────────────────────────────────────

const leadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  project: z.string().optional(),
  config: z.string().optional(),
  budget: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  brokerId: z.string().optional(),
  brokerOrg: z.string().optional(),
  sfLeadId: z.string().optional(), // Salesforce Lead Id, for later status sync
});

// POST /api/partner/leads — create a CRM Lead (sourceChannel BROKER) with a
// timeline note crediting the submitting partner.
router.post(
  '/leads',
  validate({ body: leadSchema }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof leadSchema>;
    const [min, max] = BUDGET_RANGES[b.budget ?? ''] ?? [null, null];

    // Route the broker lead to the right salesperson/team. The portal sends the
    // project as a free-text name, so it feeds geo matching (no projectId/campaign).
    // resolveIntakeOwner() is the ultimate fallback when no rule or agent applies.
    const fallbackOwnerId = await resolveIntakeOwner();
    const routing = await resolveLeadRouting(
      { sourceChannel: SourceChannel.BROKER, location: b.project ?? null },
      { fallbackOwnerId },
    );
    const ownerId = routing?.ownerId ?? fallbackOwnerId;

    const lead = await prisma.lead.create({
      data: {
        name: b.name,
        mobile: b.phone,
        email: b.email || undefined,
        bhk: b.config || undefined,
        preferredLocation: b.project || undefined,
        budgetMinPaise: toPaise(min),
        budgetMaxPaise: toPaise(max),
        sourceChannel: SourceChannel.BROKER,
        sfLeadId: b.sfLeadId || undefined,
        ownerId,
      },
    });

    const credit = [b.brokerOrg, b.brokerId].filter(Boolean).join(' · ');
    const routedNote =
      routing && routing.outcome !== 'FALLBACK'
        ? ` → auto-routed${routing.ruleName ? ` by rule "${routing.ruleName}"` : ' (default round-robin)'}`
        : '';
    await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: ActivityType.NOTE,
        summary: `Submitted via Channel Partner portal${credit ? ` (${credit})` : ''}${routedNote}`,
        detail: b.notes || undefined,
        meta: {
          brokerId: b.brokerId,
          brokerOrg: b.brokerOrg,
          project: b.project,
          source: 'broker-portal',
          routing: routing ? { outcome: routing.outcome, ruleId: routing.ruleId, ruleName: routing.ruleName } : null,
        },
        createdById: ownerId,
      },
    });

    await writeAudit({ action: AuditAction.CREATE, module: 'leads', entity: 'Lead', entityId: lead.id, newValue: lead });
    res.status(201).json({ success: true, id: lead.id });
  }),
);

// Map an incoming status (portal label, Salesforce picklist, or CRM stage name)
// to a CRM LeadStage. Case/spacing-insensitive; returns null if unmappable.
function mapToLeadStage(raw: string): LeadStage | null {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const table: Record<string, LeadStage> = {
    // Portal labels
    new: LeadStage.NEW,
    contacted: LeadStage.CONTACTED,
    site_visit_done: LeadStage.SITE_VISIT_SCHEDULED,
    site_visit: LeadStage.SITE_VISIT_SCHEDULED,
    interested: LeadStage.QUALIFIED,
    qualified: LeadStage.QUALIFIED,
    negotiation: LeadStage.NEGOTIATION,
    booked: LeadStage.CONVERTED,
    // Salesforce picklist values
    working: LeadStage.CONTACTED,
    closed_converted: LeadStage.CONVERTED,
    closed_not_converted: LeadStage.LOST,
    // CRM stage names (pass-through)
    site_visit_scheduled: LeadStage.SITE_VISIT_SCHEDULED,
    converted: LeadStage.CONVERTED,
    lost: LeadStage.LOST,
  };
  return table[k] ?? null;
}

// PATCH /api/partner/leads/status — mirror a portal status change onto the CRM
// lead correlated by its Salesforce Lead Id.
router.patch(
  '/leads/status',
  validate({ body: z.object({ sfLeadId: z.string().min(1), status: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const { sfLeadId, status } = req.body as { sfLeadId: string; status: string };
    const stage = mapToLeadStage(status);
    if (!stage) throw badRequest(`Unrecognised status "${status}"`);

    const lead = await prisma.lead.findFirst({ where: { sfLeadId } });
    if (!lead) {
      // No correlated CRM lead (e.g. created before sync, or SF-only). Not an error.
      return res.status(404).json({ success: false, error: 'No CRM lead linked to that Salesforce id' });
    }
    if (lead.stage === stage) return res.json({ success: true, id: lead.id, stage, unchanged: true });

    const updated = await prisma.lead.update({ where: { id: lead.id }, data: { stage } });
    await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: ActivityType.STAGE_CHANGE,
        summary: `Stage ${lead.stage} → ${stage} (synced from Channel Partner portal)`,
        createdById: lead.ownerId,
      },
    });
    await writeAudit({
      action: AuditAction.UPDATE,
      module: 'leads',
      entity: 'Lead',
      entityId: lead.id,
      oldValue: { stage: lead.stage },
      newValue: { stage },
    });
    res.json({ success: true, id: updated.id, stage });
  }),
);

// ── Channel-partner registration intake ──────────────────────────────────────

const cpSchema = z.object({
  orgName: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email(),
  firmType: z.string().optional(),
  city: z.string().optional(),
  pan: z.string().optional(),
  gst: z.string().optional(),
  rera: z.string().optional(),
  reraState: z.string().optional(),
});

// POST /api/partner/channel-partners — create a CHANNEL_PARTNER Account (pending
// empanelment) with a primary contact.
router.post(
  '/channel-partners',
  validate({ body: cpSchema }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof cpSchema>;
    const ownerId = await resolveIntakeOwner();

    // RERA / firm type have no native Account column; keep them in the audit
    // trail (and they can be surfaced later via custom fields if needed).
    const account = await prisma.account.create({
      data: {
        name: b.orgName,
        type: AccountType.CHANNEL_PARTNER,
        pan: b.pan || undefined,
        gstin: b.gst || undefined,
        city: b.city || undefined,
        kycStatus: KycStatus.PENDING,
        empanelmentStatus: EmpanelmentStatus.PENDING,
        ownerId,
        contacts: { create: [{ name: b.name, mobile: b.phone, email: b.email, isPrimary: true }] },
      },
      include: { contacts: true },
    });

    await writeAudit({
      action: AuditAction.CREATE,
      module: 'accounts',
      entity: 'Account',
      entityId: account.id,
      newValue: { ...account, _registration: { firmType: b.firmType, rera: b.rera, reraState: b.reraState } },
    });
    res.status(201).json({ success: true, id: account.id });
  }),
);

export default router;
