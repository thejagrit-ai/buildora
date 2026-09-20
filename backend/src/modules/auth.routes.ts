import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { AuditAction } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} from '../lib/jwt';
import { env } from '../config/env';
import { asyncHandler } from '../middleware/async';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { writeAudit } from '../middleware/audit';
import { unauthorized } from '../lib/errors';

const router = Router();

const REFRESH_DAYS = 7;
const refreshExpiry = () => new Date(Date.now() + REFRESH_DAYS * 24 * 3600 * 1000);
const RESET_MINUTES = 30;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;
const genericResetResponse = { ok: true, message: 'If an account exists for that email, password reset instructions will be sent.' };

function hashResetToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueTokens(user: { id: string; roleName: string; partnerAccountId: string | null; organizationId: string; membershipId: string }) {
  const accessToken = signAccessToken({
    sub: user.id,
    role: user.roleName,
    organizationId: user.organizationId,
    membershipId: user.membershipId,
    partnerAccountId: user.partnerAccountId,
  });
  const refreshToken = signRefreshToken(user.id, user.organizationId, user.membershipId);
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiry() },
  });
  return { accessToken, refreshToken };
}

// POST /api/auth/login
router.post(
  '/login',
  validate({ body: z.object({ email: z.string().email(), password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email }, include: { memberships: { where: { status: 'ACTIVE', organization: { status: 'ACTIVE' } }, include: { role: true }, orderBy: { createdAt: 'asc' }, take: 1 } } });
    if (!user || !user.isActive) throw unauthorized('Invalid credentials');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw unauthorized('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const nextFailures = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: nextFailures,
          lockedUntil: nextFailures >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      throw unauthorized('Invalid credentials');
    }

    const membership = user.memberships[0];
    if (!membership) throw unauthorized('Invalid credentials');
    const tokens = await issueTokens({
      id: user.id,
      roleName: membership.role.name,
      partnerAccountId: user.partnerAccountId,
      organizationId: membership.organizationId,
      membershipId: membership.id,
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
    await writeAudit({ userId: user.id, action: AuditAction.LOGIN, module: 'auth', entity: 'User', entityId: user.id, ip: req.ip });

    res.json({
      ...tokens,
      user: { id: user.id, name: user.name, email: user.email, role: membership.role.name, organizationId: membership.organizationId },
    });
  }),
);

// POST /api/auth/forgot-password. This endpoint intentionally returns the same response
// regardless of whether the address exists, preventing account enumeration.
router.post(
  '/forgot-password',
  validate({ body: z.object({ email: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (user && user.isActive) {
      const rawToken = crypto.randomBytes(32).toString('base64url');
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(rawToken),
          expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000),
        },
      });
      // Delivery is intentionally delegated to the notification provider. Never log or return rawToken.
      req.app.emit('password-reset-requested', { userId: user.id, token: rawToken });
    }
    res.json(genericResetResponse);
  }),
);

router.post(
  '/reset-password',
  validate({ body: z.object({ token: z.string().min(32), password: z.string().min(12).max(128) }) }),
  asyncHandler(async (req, res) => {
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashResetToken(req.body.token) } });
    if (!record || record.usedAt || record.expiresAt <= new Date()) throw unauthorized('Invalid or expired reset token');
    const passwordHash = await bcrypt.hash(req.body.password, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    res.json({ ok: true });
  }),
);

router.post(
  '/change-password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) }) }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) throw unauthorized('Invalid credentials');
    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    res.json({ ok: true });
  }),
);

// POST /api/auth/refresh
router.post(
  '/refresh',
  validate({ body: z.object({ refreshToken: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw unauthorized('Invalid refresh token');
    }
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw unauthorized('Refresh token expired or revoked');
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub, memberships: { some: { id: payload.membershipId, organizationId: payload.organizationId, status: 'ACTIVE', organization: { status: 'ACTIVE' } } } }, include: { memberships: { where: { id: payload.membershipId, organizationId: payload.organizationId, status: 'ACTIVE' }, include: { role: true } } } });
    if (!user || !user.isActive) throw unauthorized();

    // Rotate: revoke old, issue new.
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const membership = user.memberships[0];
    if (!membership) throw unauthorized();
    const tokens = await issueTokens({
      id: user.id,
      roleName: membership.role.name,
      partnerAccountId: user.partnerAccountId,
      organizationId: membership.organizationId,
      membershipId: membership.id,
    });
    res.json(tokens);
  }),
);

// POST /api/auth/logout
router.post(
  '/logout',
  validate({ body: z.object({ refreshToken: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    if (req.body.refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(req.body.refreshToken) },
        data: { revokedAt: new Date() },
      });
    }
    res.json({ ok: true });
  }),
);

// GET /api/auth/me
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { memberships: { where: { id: req.user!.membershipId, organizationId: req.user!.organizationId, status: 'ACTIVE' }, include: { role: true, organization: true } } },
    });
    if (!user) throw unauthorized();
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: req.user!.role,
      roleLabel: user.memberships[0]?.role.label,
      organization: user.memberships[0] ? { id: user.memberships[0].organization.id, name: user.memberships[0].organization.name, slug: user.memberships[0].organization.slug } : null,
      timezone: user.timezone,
      partnerAccountId: user.partnerAccountId,
      permissions: [...(req.user!.permissions ?? [])],
    });
  }),
);

export default router;
