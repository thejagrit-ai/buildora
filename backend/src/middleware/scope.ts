// Row-level security helpers. By default, users see only records they own or are
// assigned. Broader access comes from tenant-local permission scopes.
import { AuthUser } from './auth';

export const hasGlobalView = (user: AuthUser, permission?: string) => {
  if (permission) return (user.permissionScopes.get(permission) ?? 'ORGANIZATION') === 'ORGANIZATION';
  return [...user.permissionScopes.values()].some((scope) => scope === 'ORGANIZATION');
};

/**
 * Returns a Prisma `where` fragment scoping records to the user.
 * @param ownerField the FK column that denotes ownership (e.g. "ownerId", "agentId").
 */
export function scopeFilter(
  user: AuthUser,
  ownerField: string = 'ownerId',
  permission?: string,
): Record<string, unknown> {
  if (hasGlobalView(user, permission)) return {};
  if (user.partnerAccountId && [...user.permissionScopes.values()].includes('OWNED')) {
    return { channelPartnerId: user.partnerAccountId };
  }
  return { [ownerField]: user.id };
}

/** Throws-style guard: can this user act on a record with the given owner? */
export function canActOnOwned(user: AuthUser, ownerId: string, permission?: string): boolean {
  if (hasGlobalView(user, permission)) return true;
  return ownerId === user.id;
}
