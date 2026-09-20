import { Request, Response, NextFunction } from 'express';
import { forbidden, unauthorized } from '../lib/errors';
import { tenantContext } from '../lib/tenantContext';

// Tenant context is created exclusively from the authenticated membership.
// It deliberately ignores organization IDs supplied by clients.
export function requireTenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!req.user.organizationId || !req.user.membershipId) return next(forbidden('An active organization membership is required'));
  tenantContext.run({ organizationId: req.user.organizationId, membershipId: req.user.membershipId, userId: req.user.id }, next);
}
