// Global search across leads, accounts, opportunities, units, bookings.
// Uses case-insensitive contains (PostgreSQL ILIKE) for fuzzy-ish matching.
// Swap to pg_trgm / full-text or Elasticsearch for scale; the contract is stable.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { validate } from '../middleware/validate';
import { scopeFilter, hasGlobalView } from '../middleware/scope';

const router = Router();

router.get(
  '/',
  validate({ query: z.object({ q: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string).trim();
    const ci = { contains: q, mode: 'insensitive' as const };
    const limit = 8;

    const scoped = scopeFilter(req.user!, 'ownerId');
    const visitScope = hasGlobalView(req.user!) ? {} : { agentId: req.user!.id };

    const [leads, accounts, opportunities, units, bookings] = await Promise.all([
      prisma.lead.findMany({
        where: { AND: [scoped, { OR: [{ name: ci }, { mobile: ci }, { email: ci }] }] },
        take: limit,
        select: { id: true, name: true, mobile: true, stage: true },
      }),
      prisma.account.findMany({
        where: { AND: [scoped, { OR: [{ name: ci }, { pan: ci }, { gstin: ci }] }] },
        take: limit,
        select: { id: true, name: true, type: true, kycStatus: true },
      }),
      prisma.opportunity.findMany({
        where: { AND: [scoped, { name: ci }] },
        take: limit,
        select: { id: true, name: true, stage: true },
      }),
      prisma.inventoryUnit.findMany({
        where: { unitNumber: ci },
        take: limit,
        select: { id: true, unitNumber: true, status: true, projectId: true },
      }),
      prisma.booking.findMany({
        where: { AND: [visitScope, { bookingNumber: ci }] },
        take: limit,
        select: { id: true, bookingNumber: true, status: true },
      }),
    ]);

    res.json({ leads, accounts, opportunities, units, bookings });
  }),
);

export default router;
