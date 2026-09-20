import { Request, Response, NextFunction } from 'express';
import { PermissionScope } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { rolePermissionCache } from './auth';

/**
 * Load every role's permission set into memory once at boot. Cheap to keep in
 * process; invalidate by restarting or calling reloadPermissions() after an
 * admin changes the matrix.
 */
export async function reloadPermissions() {
  const roles = await prisma.role.findMany({
    include: { permissions: { include: { permission: true } } },
  });
  rolePermissionCache.clear();
  for (const role of roles) {
    rolePermissionCache.set(
      role.name,
      new Set(role.permissions.map((rp) => rp.permission.key)),
    );
  }
}

/** Require one of the given permission keys. No role-name bypass is permitted. */
export const authorize =
  (...required: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const ok = required.some((p) => req.user!.permissions.has(p));
    if (!ok) return next(forbidden(`Requires one of: ${required.join(', ')}`));
    next();
  };

export const requireAllPermissions =
  (...required: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!required.every((permission) => req.user!.permissions.has(permission))) {
      return next(forbidden(`Requires all of: ${required.join(', ')}`));
    }
    next();
  };

export function getPermissionScope(req: Request, permission: string): PermissionScope | undefined {
  return req.user?.permissionScopes.get(permission);
}

export const requirePermissionScope =
  (permission: string, ...allowedScopes: PermissionScope[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.permissions.has(permission)) return next(forbidden(`Requires: ${permission}`));
    const scope = getPermissionScope(req, permission) ?? 'ORGANIZATION';
    if (!allowedScopes.includes(scope)) return next(forbidden('Insufficient permission scope'));
    next();
  };

/** Restrict a route to specific roles regardless of fine-grained permissions. */
export const requireRole =
  (...roles: import('@prisma/client').RoleName[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
