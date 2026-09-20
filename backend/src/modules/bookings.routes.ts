import { Router } from 'express';
import { z } from 'zod';
import {
  AuditAction,
  BookingStatus,
  Prisma,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { hasGlobalView } from '../middleware/scope';
import { allotmentLetterHtml } from '../lib/pdf';
import { bumpCounter, formatDocNumber } from '../lib/sequence';
import { buildS3Key, getSignedUploadUrl } from '../lib/storage';

const router = Router();

// Forward booking status flow. CANCELLED is reached only through the dual
// approval workflow (/cancel + /approve), never through PATCH /status.
const FORWARD_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  INITIATED: ['AMOUNT_RECEIVED'],
  AMOUNT_RECEIVED: ['AGREEMENT_SENT'],
  AGREEMENT_SENT: ['AGREEMENT_SIGNED'],
  AGREEMENT_SIGNED: ['CONFIRMED'],
  CONFIRMED: [],
  CANCELLED: [],
};

const STATUS_VALUES = [
  'INITIATED',
  'AMOUNT_RECEIVED',
  'AGREEMENT_SENT',
  'AGREEMENT_SIGNED',
  'CONFIRMED',
] as const;

const coApplicantSchema = z.object({
  name: z.string().min(1),
  pan: z.string().optional(),
  aadhaar: z.string().optional(),
  relation: z.string().optional(),
  share: z.number().nonnegative().optional(),
});

const createBookingBody = z.object({
  accountId: z.string().uuid(),
  unitId: z.string().uuid(),
  projectId: z.string().uuid(),
  opportunityId: z.string().uuid().optional(),
  quotationId: z.string().uuid().optional(),
  channelPartnerId: z.string().uuid().optional(),
  bookingAmountRupees: z.number().nonnegative().default(0),
  totalValueRupees: z.number().nonnegative().default(0),
  paymentMode: z.string().optional(),
  agentId: z.string().uuid().optional(),
  coApplicants: z.array(coApplicantSchema).optional(),
});

// ─── List ──────────────────────────────────────────────────────────────────

// GET /api/bookings
router.get(
  '/',
  authorize('bookings.read'),
  validate({
    query: listQuerySchema.extend({
      status: z.string().optional(),
      projectId: z.string().uuid().optional(),
      accountId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & {
      status?: string;
      projectId?: string;
      accountId?: string;
    };

    // Scope: agents see their own bookings (agentId), channel partners see
    // bookings tied to their partner account; global-view roles see all.
    let scope: Record<string, unknown> = {};
    if (!hasGlobalView(req.user!)) {
      if (req.user!.role === RoleName.CHANNEL_PARTNER) {
        scope = { channelPartnerId: req.user!.partnerAccountId };
      } else {
        scope = { agentId: req.user!.id };
      }
    }

    const where = {
      ...scope,
      ...(q.status ? { status: q.status as BookingStatus } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: {
          account: { select: { name: true } },
          unit: { select: { unitNumber: true } },
          project: { select: { name: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// ─── Create ──────────────────────────────────────────────────────────────────

// POST /api/bookings
router.post(
  '/',
  authorize('bookings.create'),
  validate({ body: createBookingBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof createBookingBody>;

    const account = await prisma.account.findUnique({ where: { id: b.accountId } });
    if (!account) throw notFound('Account not found');
    if (account.kycStatus !== 'VERIFIED') throw badRequest('KYC must be verified');

    const unit = await prisma.inventoryUnit.findUnique({ where: { id: b.unitId } });
    if (!unit) throw notFound('Unit not found');
    if (unit.projectId !== b.projectId) throw badRequest('The selected unit does not belong to the selected project');
    // A bookable unit is either free (AVAILABLE) or held/blocked for this deal.
    if (unit.status !== UnitStatus.AVAILABLE && unit.status !== UnitStatus.BLOCKED) {
      throw conflict(`Unit is ${unit.status}; only AVAILABLE or BLOCKED units can be booked`);
    }

    const booking = await prisma.$transaction(async (tx) => {
      // Atomically claim the unit before creating the booking. The conditional
      // write—not a stale UI/API read—is the concurrency boundary.
      const claimed = await tx.inventoryUnit.updateMany({
        where: { id: b.unitId, status: { in: [UnitStatus.AVAILABLE, UnitStatus.BLOCKED] } },
        data: { status: UnitStatus.BOOKED, holdById: null, holdReason: null, holdExpiresAt: null },
      });
      if (claimed.count !== 1) throw conflict('This unit is no longer available for booking');
      const seq = await bumpCounter(tx, 'booking');
      const created = await tx.booking.create({
        data: {
          bookingNumber: formatDocNumber('BK', seq),
          accountId: b.accountId,
          unitId: b.unitId,
          projectId: b.projectId,
          opportunityId: b.opportunityId,
          quotationId: b.quotationId,
          channelPartnerId: b.channelPartnerId,
          agentId: b.agentId ?? req.user!.id,
          status: BookingStatus.INITIATED,
          bookingAmountPaise: BigInt(Math.round(b.bookingAmountRupees * 100)),
          totalValuePaise: BigInt(Math.round(b.totalValueRupees * 100)),
          paymentMode: b.paymentMode,
          ...(b.coApplicants && b.coApplicants.length > 0
            ? {
                coApplicants: {
                  create: b.coApplicants.map((c) => ({
                    name: c.name,
                    pan: c.pan,
                    aadhaar: c.aadhaar,
                    relation: c.relation,
                    share: c.share != null ? new Prisma.Decimal(c.share) : undefined,
                  })),
                },
              }
            : {}),
        },
        include: { coApplicants: true },
      });

      return created;
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'bookings', entity: 'Booking', entityId: booking.id, newValue: booking });
    res.status(201).json(booking);
  }),
);

// ─── Detail ──────────────────────────────────────────────────────────────────

// GET /api/bookings/:id
router.get(
  '/:id',
  authorize('bookings.read'),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        account: true,
        unit: true,
        project: true,
        coApplicants: true,
        documents: true,
        demands: true,
        receipts: true,
        approvals: true,
        opportunity: true,
      },
    });
    if (!booking) throw notFound('Booking not found');
    res.json(booking);
  }),
);

// ─── Status transitions ────────────────────────────────────────────────────────

// PATCH /api/bookings/:id/status
router.patch(
  '/:id/status',
  authorize('bookings.update'),
  validate({ body: z.object({ status: z.enum(STATUS_VALUES) }) }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');
    const next = req.body.status as BookingStatus;

    if (!FORWARD_TRANSITIONS[booking.status].includes(next)) {
      throw badRequest(`Illegal transition ${booking.status} → ${next}`);
    }

    // A booking cannot be marked AMOUNT_RECEIVED until money is actually in:
    // at least one receipt must exist for the booking.
    if (next === BookingStatus.AMOUNT_RECEIVED) {
      const receiptCount = await prisma.receipt.count({ where: { bookingId: booking.id } });
      if (receiptCount === 0) {
        throw badRequest('Cannot move to AMOUNT_RECEIVED without a recorded receipt');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.booking.update({
        where: { id: booking.id },
        data: { status: next },
      });
      // Confirming a booking locks the linked opportunity as WON.
      if (next === BookingStatus.CONFIRMED && booking.opportunityId) {
        await tx.opportunity.update({
          where: { id: booking.opportunityId },
          data: { stage: 'WON', probability: 100 },
        });
      }
      return result;
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'bookings', entity: 'Booking', entityId: booking.id, oldValue: { status: booking.status }, newValue: { status: next } });
    res.json(updated);
  }),
);

// ─── Documents ─────────────────────────────────────────────────────────────────

// POST /api/bookings/:id/documents
router.post(
  '/:id/documents',
  authorize('bookings.update'),
  validate({
    body: z.object({
      category: z.enum(['AGREEMENT', 'CHEQUE', 'NOC']),
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.number().int().nonnegative().default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const body = req.body as {
      category: 'AGREEMENT' | 'CHEQUE' | 'NOC';
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    };

    const s3Key = buildS3Key(body.category, body.fileName);
    const uploadUrl = await getSignedUploadUrl(s3Key, body.mimeType);

    const document = await prisma.document.create({
      data: {
        bookingId: booking.id,
        category: body.category,
        fileName: body.fileName,
        s3Key,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        uploadedById: req.user!.id,
      },
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'bookings', entity: 'Document', entityId: document.id, newValue: document });
    res.status(201).json({ document, uploadUrl });
  }),
);

// ─── Cancellation (dual approval) ───────────────────────────────────────────────

// POST /api/bookings/:id/cancel
router.post(
  '/:id/cancel',
  authorize('bookings.cancel'),
  validate({
    body: z.object({
      cancellationReason: z.string().min(1),
      cancellationChargesRupees: z.number().nonnegative().default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { approvals: true },
    });
    if (!booking) throw notFound('Booking not found');
    if (booking.status === BookingStatus.CANCELLED) {
      throw conflict('Booking is already cancelled');
    }

    const body = req.body as { cancellationReason: string; cancellationChargesRupees: number };

    // Dual approval: CRM Admin + Finance must both sign off. Create the pending
    // approval rows that don't already exist.
    const existingRoles = new Set(
      booking.approvals.filter((a) => a.kind === 'CANCELLATION').map((a) => a.approverRole),
    );
    const requiredRoles: RoleName[] = [RoleName.CRM_ADMIN, RoleName.FINANCE];

    await prisma.$transaction(async (tx) => {
      for (const role of requiredRoles) {
        if (!existingRoles.has(role)) {
          await tx.bookingApproval.create({
            data: {
              bookingId: booking.id,
              kind: 'CANCELLATION',
              approverRole: role,
              status: 'PENDING',
            },
          });
        }
      }
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          cancellationReason: body.cancellationReason,
          cancellationChargesPaise: BigInt(Math.round(body.cancellationChargesRupees * 100)),
          refundStatus: 'INITIATED',
        },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'bookings', entity: 'Booking', entityId: booking.id, oldValue: { status: booking.status }, newValue: { cancellationRequested: true, reason: body.cancellationReason } });

    const pendingApprovals = await prisma.bookingApproval.findMany({
      where: { bookingId: booking.id, kind: 'CANCELLATION' },
    });
    res.status(202).json({ message: 'Cancellation requires dual approval', pendingApprovals });
  }),
);

// ─── Approve / reject cancellation ──────────────────────────────────────────────

// POST /api/bookings/:id/approve
router.post(
  '/:id/approve',
  authorize('finance.approveCancel'),
  validate({
    body: z.object({
      approvalId: z.string().uuid(),
      decision: z.enum(['APPROVED', 'REJECTED']),
      remarks: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { approvals: true },
    });
    if (!booking) throw notFound('Booking not found');

    const body = req.body as {
      approvalId: string;
      decision: 'APPROVED' | 'REJECTED';
      remarks?: string;
    };

    const approval = booking.approvals.find((a) => a.id === body.approvalId);
    if (!approval) throw notFound('Approval not found for this booking');

    const result = await prisma.$transaction(async (tx) => {
      await tx.bookingApproval.update({
        where: { id: approval.id },
        data: {
          status: body.decision,
          remarks: body.remarks,
          approvedById: req.user!.id,
          decidedAt: new Date(),
        },
      });

      const cancellationApprovals = await tx.bookingApproval.findMany({
        where: { bookingId: booking.id, kind: 'CANCELLATION' },
      });

      const allApproved =
        cancellationApprovals.length > 0 &&
        cancellationApprovals.every((a) => a.status === 'APPROVED');

      if (allApproved) {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() },
        });
        // Release the unit back to AVAILABLE.
        await tx.inventoryUnit.update({
          where: { id: booking.unitId },
          data: { status: UnitStatus.AVAILABLE },
        });
        // Roll the opportunity back to LOST (no longer WON).
        if (booking.opportunityId) {
          await tx.opportunity.update({
            where: { id: booking.opportunityId },
            data: { stage: 'LOST', probability: 0 },
          });
        }
        return { cancelled: true };
      }
      return { cancelled: false };
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'bookings', entity: 'BookingApproval', entityId: approval.id, oldValue: { status: approval.status }, newValue: { status: body.decision, cancelled: result.cancelled } });

    const approvals = await prisma.bookingApproval.findMany({
      where: { bookingId: booking.id, kind: 'CANCELLATION' },
    });
    res.json({ ...result, approvals });
  }),
);

// ─── Amendment ──────────────────────────────────────────────────────────────────

// POST /api/bookings/:id/amend
router.post(
  '/:id/amend',
  authorize('bookings.amend'),
  validate({
    body: z.object({
      newUnitId: z.string().uuid().optional(),
      applicantNameChange: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    const body = req.body as { newUnitId?: string; applicantNameChange?: string };
    if (!body.newUnitId && !body.applicantNameChange) {
      throw badRequest('Provide newUnitId or applicantNameChange');
    }

    const result = await prisma.$transaction(async (tx) => {
      let updatedBooking = booking;

      // Unit change: the new unit must be AVAILABLE; swap statuses.
      if (body.newUnitId && body.newUnitId !== booking.unitId) {
        const newUnit = await tx.inventoryUnit.findUnique({ where: { id: body.newUnitId } });
        if (!newUnit) throw notFound('New unit not found');
        if (newUnit.status !== UnitStatus.AVAILABLE) {
          throw conflict(`New unit is ${newUnit.status}; must be AVAILABLE`);
        }
        // Release the old unit, occupy the new one.
        await tx.inventoryUnit.update({
          where: { id: booking.unitId },
          data: { status: UnitStatus.AVAILABLE },
        });
        await tx.inventoryUnit.update({
          where: { id: body.newUnitId },
          data: { status: UnitStatus.BOOKED },
        });
        updatedBooking = await tx.booking.update({
          where: { id: booking.id },
          data: { unitId: body.newUnitId },
        });
      }

      // Name change requires an AMENDMENT approval.
      let approval: Prisma.BookingApprovalGetPayload<object> | null = null;
      if (body.applicantNameChange) {
        approval = await tx.bookingApproval.create({
          data: {
            bookingId: booking.id,
            kind: 'AMENDMENT',
            approverRole: RoleName.CRM_ADMIN,
            status: 'PENDING',
            remarks: `Applicant name change to: ${body.applicantNameChange}`,
          },
        });
      }

      return { booking: updatedBooking, approval };
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'bookings', entity: 'Booking', entityId: booking.id, oldValue: { unitId: booking.unitId }, newValue: { newUnitId: body.newUnitId, applicantNameChange: body.applicantNameChange } });
    res.json(result);
  }),
);

// ─── Commission ──────────────────────────────────────────────────────────────

// GET /api/bookings/:id/commission
router.get(
  '/:id/commission',
  authorize('bookings.commission'),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');

    if (!booking.channelPartnerId) {
      return res.json({
        channelPartnerId: null,
        commissionPercent: 0,
        totalValuePaise: booking.totalValuePaise.toString(),
        commissionPaise: '0',
      });
    }

    const partner = await prisma.account.findUnique({ where: { id: booking.channelPartnerId } });
    if (!partner) throw notFound('Channel partner account not found');

    const percent = partner.commissionPercent ? Number(partner.commissionPercent) : 0;
    // commission = totalValue * percent / 100 (basis-point safe BigInt math).
    const commissionPaise =
      (booking.totalValuePaise * BigInt(Math.round(percent * 100))) / 10000n;

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { commissionPaise },
    });

    res.json({
      channelPartnerId: booking.channelPartnerId,
      commissionPercent: percent,
      totalValuePaise: booking.totalValuePaise.toString(),
      commissionPaise: updated.commissionPaise?.toString() ?? '0',
    });
  }),
);

// ─── Allotment letter ──────────────────────────────────────────────────────────

// GET /api/bookings/:id/allotment-letter
router.get(
  '/:id/allotment-letter',
  authorize('bookings.read'),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        account: { select: { name: true } },
        project: { select: { name: true } },
        unit: { include: { tower: { select: { name: true } } } },
      },
    });
    if (!booking) throw notFound('Booking not found');

    const html = allotmentLetterHtml({
      bookingNumber: booking.bookingNumber,
      customerName: booking.account.name,
      unitLabel: `${booking.unit.tower.name}-${booking.unit.unitNumber}`,
      projectName: booking.project.name,
      totalPaise: booking.totalValuePaise,
      bookingDate: booking.bookingDate.toISOString().slice(0, 10),
    });
    res.json({ html });
  }),
);

export default router;
