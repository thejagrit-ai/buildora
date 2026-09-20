import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, Prisma, QuotationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { scopeFilter } from '../middleware/scope';
import { notifyUser } from '../lib/notify';
import { gstOn } from '../lib/money';
import { bumpCounter, formatDocNumber } from '../lib/sequence';
import { quotationHtml } from '../lib/pdf';
import { env } from '../config/env';

const router = Router();

const STATUSES = [
  'DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REVISED', 'EXPIRED', 'DECLINED',
] as const;

/**
 * Discount approval threshold matrix (percentage of subtotal):
 *   Agent    : 0–1%   (no approval needed)
 *   Manager  : 1–3%   (requires PROJECT_MANAGER / CRM_ADMIN approval)
 *   Finance  : 3–5%   (requires FINANCE approval)
 *   > 5%     : blocked entirely
 * The approval itself is recorded via POST /:id/approve-discount; this constant
 * documents the bands that drive when an approval is required.
 */
const DISCOUNT_BANDS = {
  AGENT_MAX: 1,
  MANAGER_MAX: 3,
  FINANCE_MAX: 5,
} as const;

const lineItemSchema = z.object({
  label: z.string().min(1),
  category: z.string().min(1),
  quantity: z.number().positive().default(1),
  rateRupees: z.number().nonnegative(),
  // Taxable items default to the under-construction GST rate; informational
  // items (e.g. stamp duty estimate) pass gstRate 0 and isInformational true.
  gstRate: z.number().nonnegative().optional(),
  isInformational: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

const discountSchema = z
  .object({
    discountType: z.enum(['FLAT', 'PERCENT', 'SCHEME']),
    discountValue: z.number().nonnegative(),
  })
  .optional();

const quotationBody = z.object({
  accountId: z.string().uuid(),
  opportunityId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  validUntil: z.coerce.date().optional(),
  discount: discountSchema,
  lineItems: z.array(lineItemSchema).min(1),
});

type LineItemInput = z.infer<typeof lineItemSchema>;
type DiscountInput = z.infer<typeof discountSchema>;

interface ComputedLineItem {
  label: string;
  category: string;
  quantity: Prisma.Decimal;
  ratePaise: bigint;
  amountPaise: bigint;
  gstRate: Prisma.Decimal;
  gstPaise: bigint;
  isInformational: boolean;
  sortOrder: number;
}

// Builds line item rows and the rolled-up totals from raw input.
function computeLineItems(items: LineItemInput[]) {
  const computed: ComputedLineItem[] = [];
  let subtotalPaise = 0n;
  let gstPaise = 0n;

  for (const li of items) {
    const ratePaise = BigInt(Math.round(li.rateRupees * 100));
    // amount = quantity × rate. Quantity is a Decimal-typed value; round to paise.
    const amountPaise = BigInt(Math.round(li.quantity * Number(ratePaise)));
    // Informational lines (stamp duty etc.) carry no GST and don't add to taxable subtotal.
    const effectiveGstRate = li.isInformational
      ? 0
      : li.gstRate ?? env.GST_RATE_UNDER_CONSTRUCTION;
    const lineGst = li.isInformational ? 0n : gstOn(amountPaise, effectiveGstRate);

    computed.push({
      label: li.label,
      category: li.category,
      quantity: new Prisma.Decimal(li.quantity),
      ratePaise,
      amountPaise,
      gstRate: new Prisma.Decimal(effectiveGstRate),
      gstPaise: lineGst,
      isInformational: li.isInformational,
      sortOrder: li.sortOrder,
    });

    if (!li.isInformational) {
      subtotalPaise += amountPaise;
      gstPaise += lineGst;
    }
  }

  return { computed, subtotalPaise, gstPaise };
}

// Applies a FLAT (rupees) or PERCENT discount against the subtotal, returning
// the discount amount in paise (clamped to the subtotal).
function discountPaise(subtotalPaise: bigint, discount: DiscountInput): bigint {
  if (!discount) return 0n;
  if (discount.discountType === 'PERCENT') {
    const d = (subtotalPaise * BigInt(Math.round(discount.discountValue * 100))) / 10000n;
    return d > subtotalPaise ? subtotalPaise : d;
  }
  // FLAT and SCHEME are treated as flat rupee reductions.
  const d = BigInt(Math.round(discount.discountValue * 100));
  return d > subtotalPaise ? subtotalPaise : d;
}

// ─── List ──────────────────────────────────────────────────────────────────

// GET /api/quotations
router.get(
  '/',
  authorize('quotations.read'),
  validate({
    query: listQuerySchema.extend({
      status: z.string().optional(),
      accountId: z.string().uuid().optional(),
      opportunityId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & {
      status?: string;
      accountId?: string;
      opportunityId?: string;
    };
    const where = {
      ...scopeFilter(req.user!, 'ownerId'),
      ...(q.status ? { status: q.status as QuotationStatus } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
      ...(q.opportunityId ? { opportunityId: q.opportunityId } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: { account: { select: { name: true } }, _count: { select: { lineItems: true } } },
      }),
      prisma.quotation.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// ─── Create ──────────────────────────────────────────────────────────────────

// POST /api/quotations
router.post(
  '/',
  authorize('quotations.create'),
  validate({ body: quotationBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof quotationBody>;
    const account = await prisma.account.findUnique({ where: { id: b.accountId } });
    if (!account) throw notFound('Account not found');

    const { computed, subtotalPaise, gstPaise } = computeLineItems(b.lineItems);
    const discount = discountPaise(subtotalPaise, b.discount);
    const totalPaise = subtotalPaise + gstPaise - discount;

    const quotation = await prisma.$transaction(async (tx) => {
      const seq = await bumpCounter(tx, 'quotation');
      return tx.quotation.create({
        data: {
          quoteNumber: formatDocNumber('QT', seq),
          version: 1,
          accountId: b.accountId,
          opportunityId: b.opportunityId,
          unitId: b.unitId,
          ownerId: req.user!.id,
          status: 'DRAFT',
          validUntil: b.validUntil,
          discountType: b.discount?.discountType,
          discountValue: b.discount ? new Prisma.Decimal(b.discount.discountValue) : undefined,
          subtotalPaise,
          gstPaise,
          totalPaise,
          lineItems: { create: computed },
        },
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'quotations', entity: 'Quotation', entityId: quotation.id, newValue: quotation });
    res.status(201).json(quotation);
  }),
);

// ─── Detail ──────────────────────────────────────────────────────────────────

// GET /api/quotations/:id
router.get(
  '/:id',
  authorize('quotations.read'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        account: true,
        opportunity: true,
      },
    });
    if (!quotation) throw notFound('Quotation not found');
    res.json(quotation);
  }),
);

// ─── Update ──────────────────────────────────────────────────────────────────

// PUT /api/quotations/:id
router.put(
  '/:id',
  authorize('quotations.update'),
  validate({ body: quotationBody.partial() }),
  asyncHandler(async (req, res) => {
    const before = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Quotation not found');

    // Rule: ACCEPTED quotes are locked. Only DRAFT / REVISED may be edited.
    if (before.status === 'ACCEPTED') {
      throw badRequest('Accepted quotations cannot be edited');
    }
    if (before.status !== 'DRAFT' && before.status !== 'REVISED') {
      throw badRequest(`Quotation in status ${before.status} cannot be edited`);
    }

    const b = req.body as Partial<z.infer<typeof quotationBody>>;

    const updated = await prisma.$transaction(async (tx) => {
      // If line items are supplied, replace them and recompute totals.
      let totals: { subtotalPaise: bigint; gstPaise: bigint; totalPaise: bigint } | undefined;
      if (b.lineItems) {
        const { computed, subtotalPaise, gstPaise } = computeLineItems(b.lineItems);
        const discount = discountPaise(
          subtotalPaise,
          b.discount ??
            (before.discountType
              ? { discountType: before.discountType as 'FLAT' | 'PERCENT' | 'SCHEME', discountValue: Number(before.discountValue ?? 0) }
              : undefined),
        );
        totals = { subtotalPaise, gstPaise, totalPaise: subtotalPaise + gstPaise - discount };
        await tx.quotationLineItem.deleteMany({ where: { quotationId: before.id } });
        await tx.quotationLineItem.createMany({
          data: computed.map((c) => ({ ...c, quotationId: before.id })),
        });
      }

      return tx.quotation.update({
        where: { id: before.id },
        data: {
          accountId: b.accountId,
          opportunityId: b.opportunityId,
          unitId: b.unitId,
          validUntil: b.validUntil,
          discountType: b.discount?.discountType,
          discountValue: b.discount ? new Prisma.Decimal(b.discount.discountValue) : undefined,
          ...(totals ?? {}),
        },
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'quotations', entity: 'Quotation', entityId: before.id, oldValue: before, newValue: updated });
    res.json(updated);
  }),
);

// ─── Status transitions ────────────────────────────────────────────────────────

const TRANSITIONS: Record<QuotationStatus, QuotationStatus[]> = {
  DRAFT: ['SENT', 'REVISED', 'EXPIRED'],
  SENT: ['VIEWED', 'ACCEPTED', 'DECLINED', 'REVISED', 'EXPIRED'],
  VIEWED: ['ACCEPTED', 'DECLINED', 'REVISED', 'EXPIRED'],
  ACCEPTED: [],
  REVISED: ['SENT', 'EXPIRED'],
  EXPIRED: [],
  DECLINED: [],
};

// PATCH /api/quotations/:id/status
router.patch(
  '/:id/status',
  authorize('quotations.update'),
  validate({ body: z.object({ status: z.enum(STATUSES) }) }),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    if (!quotation) throw notFound('Quotation not found');
    const next = req.body.status as QuotationStatus;
    if (!TRANSITIONS[quotation.status].includes(next)) {
      throw badRequest(`Illegal transition ${quotation.status} → ${next}`);
    }

    const now = new Date();
    const updated = await prisma.quotation.update({
      where: { id: quotation.id },
      data: {
        status: next,
        ...(next === 'SENT' ? { sentAt: now } : {}),
        ...(next === 'VIEWED' ? { viewedAt: now } : {}),
        ...(next === 'ACCEPTED' ? { acceptedAt: now } : {}),
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'quotations', entity: 'Quotation', entityId: quotation.id, oldValue: { status: quotation.status }, newValue: { status: next } });
    res.json(updated);
  }),
);

// ─── Send ────────────────────────────────────────────────────────────────────

// POST /api/quotations/:id/send
router.post(
  '/:id/send',
  authorize('quotations.send'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    if (!quotation) throw notFound('Quotation not found');
    if (quotation.status === 'ACCEPTED' || quotation.status === 'DECLINED' || quotation.status === 'EXPIRED') {
      throw badRequest(`Cannot send a ${quotation.status} quotation`);
    }

    const updated = await prisma.quotation.update({
      where: { id: quotation.id },
      data: { status: 'SENT', sentAt: new Date() },
    });

    // Notify the owner that the quotation has gone out (placeholder dispatch).
    await notifyUser({
      userId: quotation.ownerId,
      type: 'QUOTATION_SENT',
      title: `Quotation ${quotation.quoteNumber} sent`,
      body: `Quotation ${quotation.quoteNumber} has been sent to the customer.`,
      link: `/quotations/${quotation.id}`,
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'quotations', entity: 'Quotation', entityId: quotation.id, oldValue: { status: quotation.status }, newValue: { status: 'SENT' } });
    res.json(updated);
  }),
);

// ─── PDF ─────────────────────────────────────────────────────────────────────

// GET /api/quotations/:id/pdf
router.get(
  '/:id/pdf',
  authorize('quotations.read'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        account: { select: { name: true } },
      },
    });
    if (!quotation) throw notFound('Quotation not found');

    // Best-effort unit label: resolve the linked unit number if present.
    let unitLabel = '—';
    if (quotation.unitId) {
      const unit = await prisma.inventoryUnit.findUnique({
        where: { id: quotation.unitId },
        include: { tower: { select: { name: true } } },
      });
      if (unit) unitLabel = `${unit.tower.name}-${unit.unitNumber}`;
    }

    const html = quotationHtml({
      quoteNumber: quotation.quoteNumber,
      customerName: quotation.account.name,
      unitLabel,
      lineItems: quotation.lineItems.map((li) => ({
        label: li.label,
        amountPaise: li.amountPaise,
        gstPaise: li.gstPaise,
      })),
      subtotalPaise: quotation.subtotalPaise,
      gstPaise: quotation.gstPaise,
      totalPaise: quotation.totalPaise,
      validUntil: quotation.validUntil ? quotation.validUntil.toISOString().slice(0, 10) : undefined,
    });
    res.json({ html });
  }),
);

// ─── Accept ──────────────────────────────────────────────────────────────────

// POST /api/quotations/:id/accept
router.post(
  '/:id/accept',
  authorize('quotations.accept'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    if (!quotation) throw notFound('Quotation not found');
    if (quotation.status === 'ACCEPTED') {
      return res.json({ ...quotation, bookingEligible: true });
    }
    if (quotation.status === 'EXPIRED' || quotation.status === 'DECLINED') {
      throw badRequest(`Cannot accept a ${quotation.status} quotation`);
    }

    const updated = await prisma.quotation.update({
      where: { id: quotation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'quotations', entity: 'Quotation', entityId: quotation.id, oldValue: { status: quotation.status }, newValue: { status: 'ACCEPTED' } });

    // Acceptance locks pricing. The bookings module owns booking creation; we
    // only signal eligibility here and do NOT create the booking.
    res.json({ ...updated, bookingEligible: true });
  }),
);

// ─── Revise ──────────────────────────────────────────────────────────────────

// POST /api/quotations/:id/revise  — new version, copies line items, keeps previous
router.post(
  '/:id/revise',
  authorize('quotations.update'),
  asyncHandler(async (req, res) => {
    const prev = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!prev) throw notFound('Quotation not found');

    const created = await prisma.$transaction(async (tx) => {
      const seq = await bumpCounter(tx, 'quotation');
      // Mark the previous version REVISED so it is no longer the live draft.
      if (prev.status === 'DRAFT' || prev.status === 'SENT' || prev.status === 'VIEWED') {
        await tx.quotation.update({ where: { id: prev.id }, data: { status: 'REVISED' } });
      }
      return tx.quotation.create({
        data: {
          quoteNumber: formatDocNumber('QT', seq),
          version: prev.version + 1,
          accountId: prev.accountId,
          opportunityId: prev.opportunityId,
          unitId: prev.unitId,
          ownerId: req.user!.id,
          status: 'DRAFT',
          validUntil: prev.validUntil,
          discountType: prev.discountType,
          discountValue: prev.discountValue,
          subtotalPaise: prev.subtotalPaise,
          gstPaise: prev.gstPaise,
          totalPaise: prev.totalPaise,
          lineItems: {
            create: prev.lineItems.map((li) => ({
              label: li.label,
              category: li.category,
              quantity: li.quantity,
              ratePaise: li.ratePaise,
              amountPaise: li.amountPaise,
              gstRate: li.gstRate,
              gstPaise: li.gstPaise,
              isInformational: li.isInformational,
              sortOrder: li.sortOrder,
            })),
          },
        },
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'quotations', entity: 'Quotation', entityId: created.id, newValue: { revisedFrom: prev.id, version: created.version } });
    res.status(201).json(created);
  }),
);

// ─── Discount approval ─────────────────────────────────────────────────────────

// POST /api/quotations/:id/approve-discount
router.post(
  '/:id/approve-discount',
  authorize('quotations.approve'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    if (!quotation) throw notFound('Quotation not found');

    // Compute the discount percentage against subtotal to validate against the band ceiling.
    const discountAmt = discountPaise(
      quotation.subtotalPaise,
      quotation.discountType
        ? { discountType: quotation.discountType as 'FLAT' | 'PERCENT' | 'SCHEME', discountValue: Number(quotation.discountValue ?? 0) }
        : undefined,
    );
    const pct = quotation.subtotalPaise > 0n
      ? Number((discountAmt * 10000n) / quotation.subtotalPaise) / 100
      : 0;
    if (pct > DISCOUNT_BANDS.FINANCE_MAX) {
      throw conflict(`Discount of ${pct}% exceeds the maximum approvable ${DISCOUNT_BANDS.FINANCE_MAX}%`);
    }

    const updated = await prisma.quotation.update({
      where: { id: quotation.id },
      data: { discountApprovedById: req.user!.id },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'quotations', entity: 'Quotation', entityId: quotation.id, oldValue: { discountApprovedById: quotation.discountApprovedById }, newValue: { discountApprovedById: req.user!.id, discountPercent: pct } });
    res.json(updated);
  }),
);

// ─── By opportunity ─────────────────────────────────────────────────────────────

// GET /api/quotations/by-opportunity/:opportunityId  — all versions ordered by version
router.get(
  '/by-opportunity/:opportunityId',
  authorize('quotations.read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.quotation.findMany({
      where: { opportunityId: req.params.opportunityId },
      orderBy: { version: 'asc' },
      include: { _count: { select: { lineItems: true } } },
    });
    res.json({ data });
  }),
);

// ─── Expiry check ───────────────────────────────────────────────────────────────

// Validity expiry: a scheduled cron/job should periodically flip SENT/VIEWED
// quotations whose validUntil is in the past to EXPIRED. This endpoint performs
// that same flip on demand (e.g. invoked by the scheduler) and returns the count.
// GET /api/quotations/expired-check
router.get(
  '/expired-check',
  authorize('quotations.read'),
  asyncHandler(async (req, res) => {
    const result = await prisma.quotation.updateMany({
      where: {
        status: { in: ['SENT', 'VIEWED'] },
        validUntil: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    res.json({ expired: result.count });
  }),
);

export default router;
