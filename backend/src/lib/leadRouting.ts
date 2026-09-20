// Lead-routing engine. Resolves which salesperson a brand-new lead should be
// assigned to, based on admin-configured LeadRoutingRule rows. Rules are ordered
// (priority asc) and first-match-wins: the first active rule whose conditions
// match the lead AND that yields an assignable owner wins. Conditions are ANDed;
// an unset condition is a wildcard. If no rule produces an owner, we fall back to
// least-loaded among all active sales agents, then to a caller-supplied owner.
//
// Used by both lead-create paths (modules/leads.routes.ts and the partner intake
// in modules/partner.routes.ts) so externally-submitted leads route too.
import { LeadRoutingRule, RoleName, RoutingStrategy, SourceChannel } from '@prisma/client';
import { prisma } from './prisma';

export interface RoutingInput {
  projectId?: string | null;
  campaignId?: string | null;
  sourceChannel?: SourceChannel | null;
  /** Free-text location (lead.city or lead.preferredLocation) for geo matching. */
  location?: string | null;
}

export type RoutingOutcome = 'RULE' | 'DEFAULT_ROUND_ROBIN' | 'FALLBACK';

export interface RoutingResult {
  ownerId: string;
  outcome: RoutingOutcome;
  ruleId: string | null;
  ruleName: string | null;
  strategy: RoutingStrategy | null;
  reason: string;
}

/** One rule's evaluation, for the admin "test routing" dry-run trace. */
export interface RuleEvaluation {
  ruleId: string;
  name: string;
  priority: number;
  matched: boolean;
  /** Why it didn't match / couldn't assign (empty when it matched & assigned). */
  skipReason: string | null;
  ownerId: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Case-insensitive, bidirectional substring match of the lead location. */
function matchesLocation(locations: string[], loc?: string | null): boolean {
  if (locations.length === 0) return true; // wildcard
  if (!loc) return false;
  const l = norm(loc);
  return locations.some((x) => {
    const xn = norm(x);
    return xn.length > 0 && (l.includes(xn) || xn.includes(l));
  });
}

/** Do a rule's conditions match the lead? (Conditions ANDed; unset = wildcard.) */
export function ruleConditionsMatch(rule: LeadRoutingRule, input: RoutingInput): boolean {
  if (rule.projectId && rule.projectId !== input.projectId) return false;
  if (rule.campaignId && rule.campaignId !== input.campaignId) return false;
  if (rule.sourceChannel && rule.sourceChannel !== input.sourceChannel) return false;
  if (!matchesLocation(rule.locations, input.location)) return false;
  return true;
}

/** Least-loaded (fewest owned leads) active user among the given ids. */
async function leastLoadedAmong(ids: string[]): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  const users = await prisma.user.findMany({
    where: { id: { in: unique }, isActive: true },
    select: { id: true, _count: { select: { ownedLeads: true } } },
  });
  if (users.length === 0) return null;
  return users.reduce((best, u) => (u._count.ownedLeads < best._count.ownedLeads ? u : best)).id;
}

/** Least-loaded active SALES_AGENT — the system-wide default round-robin. */
async function defaultRoundRobin(): Promise<string | null> {
  const agents = await prisma.user.findMany({
    where: { isActive: true, role: { name: RoleName.SALES_AGENT } },
    select: { id: true, _count: { select: { ownedLeads: true } } },
  });
  if (agents.length === 0) return null;
  return agents.reduce((best, a) => (a._count.ownedLeads < best._count.ownedLeads ? a : best)).id;
}

/** Resolve a single rule to an owner id, or null if it can't assign right now. */
async function ownerForRule(rule: LeadRoutingRule): Promise<string | null> {
  if (rule.strategy === RoutingStrategy.SPECIFIC_USER) {
    if (!rule.targetUserId) return null;
    const u = await prisma.user.findFirst({ where: { id: rule.targetUserId, isActive: true }, select: { id: true } });
    return u?.id ?? null;
  }
  return leastLoadedAmong(rule.memberIds);
}

async function activeRules(): Promise<LeadRoutingRule[]> {
  return prisma.leadRoutingRule.findMany({
    where: { active: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Resolve the owner for a new lead. Returns null only when there is no rule
 * match, no active sales agent, and no usable fallback owner.
 */
export async function resolveLeadRouting(
  input: RoutingInput,
  opts: { fallbackOwnerId?: string | null } = {},
): Promise<RoutingResult | null> {
  for (const rule of await activeRules()) {
    if (!ruleConditionsMatch(rule, input)) continue;
    const ownerId = await ownerForRule(rule);
    if (!ownerId) continue; // matched but no assignable member right now → try next rule
    return {
      ownerId,
      outcome: 'RULE',
      ruleId: rule.id,
      ruleName: rule.name,
      strategy: rule.strategy,
      reason: `Matched routing rule "${rule.name}"`,
    };
  }

  const fallbackAgent = await defaultRoundRobin();
  if (fallbackAgent) {
    return {
      ownerId: fallbackAgent,
      outcome: 'DEFAULT_ROUND_ROBIN',
      ruleId: null,
      ruleName: null,
      strategy: RoutingStrategy.ROUND_ROBIN,
      reason: 'No routing rule matched — assigned to least-loaded sales agent',
    };
  }

  if (opts.fallbackOwnerId) {
    return {
      ownerId: opts.fallbackOwnerId,
      outcome: 'FALLBACK',
      ruleId: null,
      ruleName: null,
      strategy: null,
      reason: 'No routing rule or sales agent available — assigned to fallback owner',
    };
  }

  return null;
}

/**
 * Dry-run the engine for the admin "test routing" tool: returns the per-rule
 * evaluation trace plus the owner that would be chosen. No side effects.
 */
export async function explainLeadRouting(
  input: RoutingInput,
): Promise<{ evaluations: RuleEvaluation[]; result: RoutingResult | null }> {
  const rules = await activeRules();
  const evaluations: RuleEvaluation[] = [];
  let chosen: RoutingResult | null = null;

  for (const rule of rules) {
    const conditionsMatch = ruleConditionsMatch(rule, input);
    let ownerId: string | null = null;
    let skipReason: string | null = null;

    if (!conditionsMatch) {
      skipReason = 'Conditions did not match';
    } else {
      ownerId = await ownerForRule(rule);
      if (!ownerId) {
        skipReason =
          rule.strategy === RoutingStrategy.SPECIFIC_USER
            ? 'Target salesperson is missing or inactive'
            : 'No active member available in the team pool';
      }
    }

    const matched = conditionsMatch && !!ownerId;
    evaluations.push({ ruleId: rule.id, name: rule.name, priority: rule.priority, matched, skipReason, ownerId });

    if (matched && !chosen) {
      chosen = {
        ownerId: ownerId!,
        outcome: 'RULE',
        ruleId: rule.id,
        ruleName: rule.name,
        strategy: rule.strategy,
        reason: `Matched routing rule "${rule.name}"`,
      };
    }
  }

  if (!chosen) chosen = await resolveLeadRouting(input);
  return { evaluations, result: chosen };
}
