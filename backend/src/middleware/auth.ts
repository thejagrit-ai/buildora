import { Request, Response, NextFunction } from 'express';
import { PermissionScope, RoleName } from '@prisma/client';
import { verifyAccessToken } from '../lib/jwt';
import { unauthorized } from '../lib/errors';

export interface AuthUser {
  id: string;
  role: RoleName;
  organizationId?: string;
  membershipId?: string;
  partnerAccountId?: string | null;
  permissions: Set<string>;
  permissionScopes: Map<string, PermissionScope>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// In-process permission cache keyed by role, populated by rbac loader at boot.
export const rolePermissionCache = new Map<RoleName, Set<string>>();

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(unauthorized('Missing bearer token'));
  }
  try {
    const payload = verifyAccessToken(header.slice(7));
    const role = payload.role as RoleName;
    const { prisma } = await import('../lib/prisma');
    const membership = await prisma.membership.findFirst({
      where: { id: payload.membershipId, userId: payload.sub, organizationId: payload.organizationId, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
      include: {
        role: true,
        organizationRole: {
          include: { permissions: { include: { permission: true } } },
        },
      },
    });
    if (!membership) return next(unauthorized('Session is no longer active'));
    const tenantPermissions = membership.organizationRole
      ? new Set(membership.organizationRole.permissions.map((rp) => rp.permission.key))
      : rolePermissionCache.get(membership.role.name) ?? new Set();
    const tenantScopes = new Map(
      membership.organizationRole?.permissions.map((rp) => [rp.permission.key, rp.scope]) ?? [],
    );
    req.user = {
      id: payload.sub,
      role: membership.role.name,
      organizationId: membership.organizationId,
      membershipId: membership.id,
      partnerAccountId: payload.partnerAccountId ?? null,
      permissions: tenantPermissions,
      permissionScopes: tenantScopes,
    };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}
