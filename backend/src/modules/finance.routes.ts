import { Router } from 'express';
import { z } from 'zod';
import {
  AuditAction,
  DemandStatus,
  PaymentMode,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { gstOn } from '../lib/money';
import { bumpCounter, formatDocNumber } from '../lib/sequence';
import { demandLetterHtml, receiptHtml } from '../lib/pdf';
import { notifyUser } from '../lib/notify';
import { env } from '../config/env';

const router = Router();

const PAYMENT_MODES = ['NEFT', 'RTGS', 'CHEQUE', 'UPI', 'DD', 'CASH'] as const;

// Forward demand status flow. OVERDUE is computed (see /demands/overdue), not a
// manual transition target.
const DEMAND_TRANSITIONS: Record<DemandStatus, DemandStatus[]> = {
  PENDING: ['SENT'],
  SENT: ['PARTIALLY_PAID', 'PAID'],
  PARTIALLY_PAID: ['PAID'],
  PAID: [],
  OVERDUE: ['PARTIALLY_PAID', 'PAID'],
};

const DEMAND_STATUS_VALUES = ['SENT', 'PARTIALLY_PAID', 'PAID'] as const;

// Resolve the appropriate demand status from how much has been paid.
function demandStatusFor(paidPaise: bigint, totalPaise: bigint, current: DemandStatus): DemandStatus {
  if (paidPaise >= totalPaise && totalPaise > 0n) return DemandStatus.PAID;
  if (paidPaise > 0n) return DemandStatus.PARTIALLY_PAID;
  // Falling back to PENDING/SENT — keep SENT if it had already been sent.
  return current === DemandStatus.SENT ? DemandStatus.SENT : DemandStatus.PENDING;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DEMANDS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/bookings/:id/demands
router.get(
  '/bookings/:id/demands',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const demands = await prisma.demandSchedule.findMany({
      where: { bookingId: booking.id },
      orderBy: { dueDate: 'asc' },
    });

    const data = demands.map((d) => ({
      ...d,
      balancePaise: (d.totalPaise - d.paidPaise).toString(),
    }));
    res.json({ data });
  }),
);

// POST /api/bookings/:id/demands  — ad-hoc demand
router.post(
  '/bookings/:id/demands',
  authorize('finance.demand'),
  validate({
    body: z.object({
      milestoneLabel: z.string().min(1),
      amountRupees: z.number().nonnegative(),
      dueDate: z.coerce.date(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const body = req.body as { milestoneLabel: string; amountRupees: number; dueDate: Date };
    const amountPaise = BigInt(Math.round(body.amountRupees * 100));
    const gstPaise = gstOn(amountPaise, env.GST_RATE_UNDER_CONSTRUCTION);
    const totalPaise = amountPaise + gstPaise;

    const demand = await prisma.$transaction(async (tx) => {
      const seq = await bumpCounter(tx, 'demand');
      return tx.demandSchedule.create({
        data: {
          demandNumber: formatDocNumber('DM', seq),
          bookingId: booking.id,
          milestoneLabel: body.milestoneLabel,
          status: DemandStatus.PENDING,
          dueDate: body.dueDate,
          amountPaise,
          gstPaise,
          totalPaise,
        },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'finance', entity: 'DemandSchedule', entityId: demand.id, newValue: demand });
    res.status(201).json(demand);
  }),
);

// POST /api/bookings/:id/demands/from-plan  — generate schedule from a payment plan
router.post(
  '/bookings/:id/demands/from-plan',
  authorize('finance.demand'),
  validate({ body: z.object({ planId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const plan = await prisma.paymentPlan.findUnique({
      where: { id: (req.body as { planId: string }).planId },
      include: { milestones: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!plan) throw notFound('Payment plan not found');
    if (plan.milestones.length === 0) throw badRequest('Payment plan has no milestones');

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    const demands = await prisma.$transaction(async (tx) => {
      const created: Prisma.DemandScheduleGetPayload<object>[] = [];
      for (let i = 0; i < plan.milestones.length; i++) {
        const m = plan.milestones[i];
        // amount = totalValue * percent / 100 (basis-point safe BigInt math).
        const amountPaise =
          (booking.totalValuePaise * BigInt(Math.round(Number(m.percent) * 100))) / 10000n;
        const gstPaise = gstOn(amountPaise, env.GST_RATE_UNDER_CONSTRUCTION);
        const totalPaise = amountPaise + gstPaise;
        const seq = await bumpCounter(tx, 'demand');
        const demand = await tx.demandSchedule.create({
          data: {
            demandNumber: formatDocNumber('DM', seq),
            bookingId: booking.id,
            milestoneLabel: m.label,
            status: DemandStatus.PENDING,
            dueDate: new Date(now + i * 30 * DAY_MS),
            amountPaise,
            gstPaise,
            totalPaise,
          },
        });
        created.push(demand);
      }
      return created;
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'finance', entity: 'DemandSchedule', entityId: booking.id, newValue: { planId: plan.id, count: demands.length } });
    res.status(201).json({ data: demands });
  }),
);

// GET /api/demands/:id
router.get(
  '/demands/:id',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const demand = await prisma.demandSchedule.findUnique({
      where: { id: req.params.id },
      include: { booking: { select: { bookingNumber: true } }, receipts: true },
    });
    if (!demand) throw notFound('Demand not found');
    res.json({ ...demand, balancePaise: (demand.totalPaise - demand.paidPaise).toString() });
  }),
);

// PATCH /api/demands/:id/status
router.patch(
  '/demands/:id/status',
  authorize('finance.demand'),
  validate({ body: z.object({ status: z.enum(DEMAND_STATUS_VALUES) }) }),
  asyncHandler(async (req, res) => {
    const demand = await prisma.demandSchedule.findUnique({ where: { id: req.params.id } });
    if (!demand) throw notFound('Demand not found');
    const next = req.body.status as DemandStatus;

    if (!DEMAND_TRANSITIONS[demand.status].includes(next)) {
      throw badRequest(`Illegal transition ${demand.status} → ${next}`);
    }

    const updated = await prisma.demandSchedule.update({
      where: { id: demand.id },
      data: {
        status: next,
        ...(next === DemandStatus.SENT ? { sentAt: new Date() } : {}),
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'finance', entity: 'DemandSchedule', entityId: demand.id, oldValue: { status: demand.status }, newValue: { status: next } });
    res.json(updated);
  }),
);

// GET /api/demands/:id/letter
router.get(
  '/demands/:id/letter',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const demand = await prisma.demandSchedule.findUnique({
      where: { id: req.params.id },
      include: { booking: { select: { bookingNumber: true } } },
    });
    if (!demand) throw notFound('Demand not found');

    const html = demandLetterHtml({
      demandNumber: demand.demandNumber,
      bookingNumber: demand.booking.bookingNumber,
      milestoneLabel: demand.milestoneLabel,
      amountPaise: demand.amountPaise,
      gstPaise: demand.gstPaise,
      totalPaise: demand.totalPaise,
      dueDate: demand.dueDate.toISOString().slice(0, 10),
    });
    res.json({ html });
  }),
);

// POST /api/demands/bulk-generate  — one demand per booking for a milestone
router.post(
  '/demands/bulk-generate',
  authorize('finance.demand'),
  validate({
    body: z.object({
      bookingIds: z.array(z.string().uuid()).min(1),
      milestoneLabel: z.string().min(1),
      percent: z.number().positive(),
      dueDate: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      bookingIds: string[];
      milestoneLabel: string;
      percent: number;
      dueDate?: Date;
    };

    const bookings = await prisma.booking.findMany({ where: { id: { in: body.bookingIds } } });
    const dueDate = body.dueDate ?? new Date();

    const created = await prisma.$transaction(async (tx) => {
      const rows: Prisma.DemandScheduleGetPayload<object>[] = [];
      for (const booking of bookings) {
        const amountPaise =
          (booking.totalValuePaise * BigInt(Math.round(body.percent * 100))) / 10000n;
        const gstPaise = gstOn(amountPaise, env.GST_RATE_UNDER_CONSTRUCTION);
        const totalPaise = amountPaise + gstPaise;
        const seq = await bumpCounter(tx, 'demand');
        const demand = await tx.demandSchedule.create({
          data: {
            demandNumber: formatDocNumber('DM', seq),
            bookingId: booking.id,
            milestoneLabel: body.milestoneLabel,
            status: DemandStatus.PENDING,
            dueDate,
            amountPaise,
            gstPaise,
            totalPaise,
          },
        });
        rows.push(demand);
      }
      return rows;
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'finance', entity: 'DemandSchedule', newValue: { milestoneLabel: body.milestoneLabel, count: created.length } });
    res.status(201).json({ count: created.length });
  }),
);

// GET /api/demands/overdue  — all unpaid demands past due date
router.get(
  '/demands/overdue',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const demands = await prisma.demandSchedule.findMany({
      where: {
        dueDate: { lt: new Date() },
        status: { not: DemandStatus.PAID },
      },
      include: {
        booking: { select: { bookingNumber: true, agentId: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    // Escalation notification: ping the booking's agent for each overdue demand
    // (finance team is notified via their own dashboard feed — placeholder).
    for (const d of demands) {
      await notifyUser({
        userId: d.booking.agentId,
        type: 'DEMAND_OVERDUE',
        title: `Demand ${d.demandNumber} overdue`,
        body: `Demand ${d.demandNumber} for booking ${d.booking.bookingNumber} is past its due date.`,
        link: `/demands/${d.id}`,
      });
    }

    res.json({
      data: demands.map((d) => ({ ...d, balancePaise: (d.totalPaise - d.paidPaise).toString() })),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
//  RECEIPTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/bookings/:id/receipts
router.get(
  '/bookings/:id/receipts',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');
    const receipts = await prisma.receipt.findMany({
      where: { bookingId: booking.id },
      orderBy: { receivedAt: 'desc' },
      include: { allocations: true },
    });
    res.json({ data: receipts });
  }),
);

// POST /api/bookings/:id/receipts  — record + auto-reconcile a receipt
router.post(
  '/bookings/:id/receipts',
  authorize('finance.receipt'),
  validate({
    body: z.object({
      amountRupees: z.number().positive(),
      mode: z.enum(PAYMENT_MODES),
      bankReference: z.string().optional(),
      receivedAt: z.coerce.date().optional(),
      remarks: z.string().optional(),
      allowAdvance: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const body = req.body as {
      amountRupees: number;
      mode: (typeof PAYMENT_MODES)[number];
      bankReference?: string;
      receivedAt?: Date;
      remarks?: string;
      allowAdvance: boolean;
    };

    const amountPaise = BigInt(Math.round(body.amountRupees * 100));

    // Outstanding = sum(demand totals) - sum(demand paid). A receipt may not
    // exceed it unless explicitly flagged as an advance.
    const demands = await prisma.demandSchedule.findMany({
      where: { bookingId: booking.id },
      orderBy: { dueDate: 'asc' },
    });
    const outstanding = demands.reduce((sum, d) => sum + (d.totalPaise - d.paidPaise), 0n);
    if (!body.allowAdvance && amountPaise > outstanding) {
      throw badRequest('Receipt amount exceeds outstanding balance; set allowAdvance to override');
    }

    const gstPaise = gstOn(amountPaise, env.GST_RATE_UNDER_CONSTRUCTION);

    const receipt = await prisma.$transaction(async (tx) => {
      const seq = await bumpCounter(tx, 'receipt');
      const created = await tx.receipt.create({
        data: {
          receiptNumber: formatDocNumber('RC', seq),
          sequence: seq,
          bookingId: booking.id,
          amountPaise,
          gstPaise,
          mode: body.mode as PaymentMode,
          bankReference: body.bankReference,
          receivedAt: body.receivedAt ?? new Date(),
          remarks: body.remarks,
          createdById: req.user!.id,
        },
      });

      // Auto-reconcile: allocate oldest-first across open demands.
      let remaining = amountPaise;
      for (const d of demands) {
        if (remaining <= 0n) break;
        const due = d.totalPaise - d.paidPaise;
        if (due <= 0n) continue;
        const alloc = remaining < due ? remaining : due;
        await tx.receiptAllocation.create({
          data: { receiptId: created.id, demandId: d.id, amountPaise: alloc },
        });
        const newPaid = d.paidPaise + alloc;
        await tx.demandSchedule.update({
          where: { id: d.id },
          data: { paidPaise: newPaid, status: demandStatusFor(newPaid, d.totalPaise, d.status) },
        });
        remaining -= alloc;
      }

      return tx.receipt.findUniqueOrThrow({
        where: { id: created.id },
        include: { allocations: true },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'finance', entity: 'Receipt', entityId: receipt.id, newValue: receipt });
    res.status(201).json(receipt);
  }),
);

// GET /api/receipts/:id
router.get(
  '/receipts/:id',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const receipt = await prisma.receipt.findUnique({
      where: { id: req.params.id },
      include: { allocations: { include: { demand: true } }, booking: { select: { bookingNumber: true } } },
    });
    if (!receipt) throw notFound('Receipt not found');
    res.json(receipt);
  }),
);

// GET /api/receipts/:id/pdf
router.get(
  '/receipts/:id/pdf',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const receipt = await prisma.receipt.findUnique({
      where: { id: req.params.id },
      include: { booking: { select: { bookingNumber: true } } },
    });
    if (!receipt) throw notFound('Receipt not found');

    const html = receiptHtml({
      receiptNumber: receipt.receiptNumber,
      bookingNumber: receipt.booking.bookingNumber,
      amountPaise: receipt.amountPaise,
      gstPaise: receipt.gstPaise,
      mode: receipt.mode,
      receivedAt: receipt.receivedAt.toISOString().slice(0, 10),
    });
    res.json({ html });
  }),
);

// POST /api/receipts/:id/dishonour  — mark cheque dishonoured + reverse allocations
router.post(
  '/receipts/:id/dishonour',
  authorize('finance.receipt'),
  validate({ body: z.object({ dishonourReason: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const receipt = await prisma.receipt.findUnique({
      where: { id: req.params.id },
      include: { allocations: true },
    });
    if (!receipt) throw notFound('Receipt not found');
    if (receipt.isDishonoured) throw conflict('Receipt is already marked dishonoured');

    const body = req.body as { dishonourReason: string };

    const updated = await prisma.$transaction(async (tx) => {
      // Reverse each allocation: decrement demand.paidPaise, recompute status.
      for (const alloc of receipt.allocations) {
        const demand = await tx.demandSchedule.findUniqueOrThrow({ where: { id: alloc.demandId } });
        const newPaid = demand.paidPaise - alloc.amountPaise;
        const clamped = newPaid < 0n ? 0n : newPaid;
        await tx.demandSchedule.update({
          where: { id: demand.id },
          data: { paidPaise: clamped, status: demandStatusFor(clamped, demand.totalPaise, demand.status) },
        });
      }
      await tx.receiptAllocation.deleteMany({ where: { receiptId: receipt.id } });
      return tx.receipt.update({
        where: { id: receipt.id },
        data: { isDishonoured: true, dishonourReason: body.dishonourReason },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'finance', entity: 'Receipt', entityId: receipt.id, oldValue: { isDishonoured: false }, newValue: { isDishonoured: true, dishonourReason: body.dishonourReason } });
    res.json(updated);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
//  LEDGER
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/bookings/:id/ledger
router.get(
  '/bookings/:id/ledger',
  authorize('finance.ledger'),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const [demands, receipts] = await Promise.all([
      prisma.demandSchedule.findMany({ where: { bookingId: booking.id }, orderBy: { dueDate: 'asc' } }),
      prisma.receipt.findMany({ where: { bookingId: booking.id }, orderBy: { receivedAt: 'asc' } }),
    ]);

    const totalDemandedPaise = demands.reduce((s, d) => s + d.totalPaise, 0n);
    const totalPaidPaise = demands.reduce((s, d) => s + d.paidPaise, 0n);
    const balancePaise = totalDemandedPaise - totalPaidPaise;

    res.json({
      totalDemandedPaise: totalDemandedPaise.toString(),
      totalPaidPaise: totalPaidPaise.toString(),
      balancePaise: balancePaise.toString(),
      demands,
      receipts,
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
//  PAYMENT PLANS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/payment-plans
router.get(
  '/payment-plans',
  authorize('finance.read'),
  asyncHandler(async (_req, res) => {
    const data = await prisma.paymentPlan.findMany({
      orderBy: { createdAt: 'desc' },
      include: { milestones: { orderBy: { sortOrder: 'asc' } } },
    });
    res.json({ data });
  }),
);

// POST /api/payment-plans
router.post(
  '/payment-plans',
  authorize('finance.demand'),
  validate({
    body: z.object({
      name: z.string().min(1),
      kind: z.enum(['CONSTRUCTION_LINKED', 'TIME_LINKED', 'CUSTOM']),
      description: z.string().optional(),
      milestones: z
        .array(
          z.object({
            label: z.string().min(1),
            percent: z.number().positive(),
            sortOrder: z.number().int().default(0),
          }),
        )
        .min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      name: string;
      kind: 'CONSTRUCTION_LINKED' | 'TIME_LINKED' | 'CUSTOM';
      description?: string;
      milestones: { label: string; percent: number; sortOrder: number }[];
    };

    // Percentages should sum to ~100 — warn (don't block) if they don't.
    const sum = body.milestones.reduce((s, m) => s + m.percent, 0);
    const percentWarning = Math.abs(sum - 100) > 0.01 ? `Milestone percents sum to ${sum}, expected 100` : undefined;

    const plan = await prisma.paymentPlan.create({
      data: {
        name: body.name,
        kind: body.kind,
        description: body.description,
        milestones: {
          create: body.milestones.map((m) => ({
            label: m.label,
            percent: new Prisma.Decimal(m.percent),
            sortOrder: m.sortOrder,
          })),
        },
      },
      include: { milestones: { orderBy: { sortOrder: 'asc' } } },
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'finance', entity: 'PaymentPlan', entityId: plan.id, newValue: plan });
    res.status(201).json({ plan, ...(percentWarning ? { warning: percentWarning } : {}) });
  }),
);

// GET /api/payment-plans/:id
router.get(
  '/payment-plans/:id',
  authorize('finance.read'),
  asyncHandler(async (req, res) => {
    const plan = await prisma.paymentPlan.findUnique({
      where: { id: req.params.id },
      include: { milestones: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!plan) throw notFound('Payment plan not found');
    res.json(plan);
  }),
);

export default router;
