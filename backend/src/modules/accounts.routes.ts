import { Router } from 'express';
import { z } from 'zod';
import { AccountType, AuditAction, EmpanelmentStatus, KycStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { scopeFilter } from '../middleware/scope';
import { buildS3Key, getSignedUploadUrl } from '../lib/storage';

const router = Router();

const ACCOUNT_TYPES = ['INDIVIDUAL', 'CORPORATE', 'CHANNEL_PARTNER', 'INVESTOR'] as const;

const contactBody = z.object({
  name: z.string().min(2),
  mobile: z.string().optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().default(false),
  relation: z.string().optional(),
});

const accountBody = z.object({
  name: z.string().min(2),
  type: z.enum(ACCOUNT_TYPES),
  pan: z.string().optional(),
  gstin: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  commPreference: z.string().optional(),
  contacts: z.array(contactBody).min(1),
});

// GET /api/accounts
router.get(
  '/',
  authorize('accounts.read'),
  validate({ query: listQuerySchema.extend({ type: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & { type?: string };
    const where = {
      ...scopeFilter(req.user!, 'ownerId'),
      ...(q.type ? { type: q.type as AccountType } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { pan: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      prisma.account.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: { _count: { select: { contacts: true, opportunities: true, bookings: true } } },
      }),
      prisma.account.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// POST /api/accounts
router.post(
  '/',
  authorize('accounts.create'),
  validate({ body: accountBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof accountBody>;
    if (!b.contacts.some((c) => c.isPrimary)) {
      throw badRequest('At least one contact must be marked primary');
    }

    // Duplicate detection on pan / contact mobile / contact email.
    const orFilters: Record<string, unknown>[] = [];
    if (b.pan) orFilters.push({ pan: b.pan });
    const mobiles = b.contacts.map((c) => c.mobile).filter((m): m is string => !!m);
    const emails = b.contacts.map((c) => c.email).filter((e): e is string => !!e);
    if (mobiles.length) orFilters.push({ contacts: { some: { mobile: { in: mobiles } } } });
    if (emails.length) orFilters.push({ contacts: { some: { email: { in: emails } } } });
    if (orFilters.length) {
      const existing = await prisma.account.findFirst({
        where: { OR: orFilters },
        include: { contacts: true },
      });
      if (existing) {
        throw conflict(`Account may already exist: ${existing.name} (${existing.id})`);
      }
    }

    const account = await prisma.$transaction(async (tx) => {
      return tx.account.create({
        data: {
          name: b.name,
          type: b.type as AccountType,
          pan: b.pan,
          gstin: b.gstin,
          addressLine: b.addressLine,
          city: b.city,
          state: b.state,
          pincode: b.pincode,
          commPreference: b.commPreference,
          empanelmentStatus: b.type === 'CHANNEL_PARTNER' ? EmpanelmentStatus.PENDING : EmpanelmentStatus.NOT_REQUIRED,
          ownerId: req.user!.id,
          contacts: {
            create: b.contacts.map((c) => ({
              name: c.name,
              mobile: c.mobile,
              email: c.email,
              isPrimary: c.isPrimary,
              relation: c.relation,
            })),
          },
        },
        include: { contacts: true },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'accounts', entity: 'Account', entityId: account.id, newValue: account });
    res.status(201).json(account);
  }),
);

// GET /api/accounts/:id  — 360 view
router.get(
  '/:id',
  authorize('accounts.read'),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: true,
        documents: true,
        leads: true,
        opportunities: true,
        bookings: true,
        _count: { select: { contacts: true, documents: true, leads: true, opportunities: true, bookings: true } },
      },
    });
    if (!account) throw notFound('Account not found');
    res.json(account);
  }),
);

// PUT /api/accounts/:id
router.put(
  '/:id',
  authorize('accounts.update'),
  validate({ body: accountBody.omit({ contacts: true }).partial() }),
  asyncHandler(async (req, res) => {
    const before = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Account not found');
    const { type, ...rest } = req.body as Partial<Omit<z.infer<typeof accountBody>, 'contacts'>>;
    const account = await prisma.account.update({
      where: { id: req.params.id },
      data: { ...rest, type: type ? (type as AccountType) : undefined },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'accounts', entity: 'Account', entityId: account.id, oldValue: before, newValue: account });
    res.json(account);
  }),
);

// POST /api/accounts/:id/contacts
router.post(
  '/:id/contacts',
  authorize('accounts.update'),
  validate({ body: contactBody }),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!account) throw notFound('Account not found');
    const b = req.body as z.infer<typeof contactBody>;

    const contact = await prisma.$transaction(async (tx) => {
      if (b.isPrimary) {
        await tx.contact.updateMany({ where: { accountId: account.id, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.contact.create({
        data: {
          accountId: account.id,
          name: b.name,
          mobile: b.mobile,
          email: b.email,
          isPrimary: b.isPrimary,
          relation: b.relation,
        },
      });
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'accounts', entity: 'Contact', entityId: contact.id, newValue: contact });
    res.status(201).json(contact);
  }),
);

// GET /api/accounts/:id/documents
router.get(
  '/:id/documents',
  authorize('accounts.documents'),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!account) throw notFound('Account not found');
    const documents = await prisma.document.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: documents });
  }),
);

// POST /api/accounts/:id/documents  — register a document row + signed upload URL
router.post(
  '/:id/documents',
  authorize('accounts.documents'),
  validate({
    body: z.object({
      category: z.string().min(1),
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.number().int().nonnegative().default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!account) throw notFound('Account not found');
    const b = req.body as { category: string; fileName: string; mimeType: string; sizeBytes: number };

    const s3Key = buildS3Key(b.category, b.fileName);
    const document = await prisma.document.create({
      data: {
        accountId: account.id,
        category: b.category,
        fileName: b.fileName,
        s3Key,
        mimeType: b.mimeType,
        sizeBytes: b.sizeBytes,
        uploadedById: req.user!.id,
      },
    });
    const uploadUrl = await getSignedUploadUrl(s3Key, b.mimeType);
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'accounts', entity: 'Document', entityId: document.id, newValue: document });
    res.status(201).json({ document, uploadUrl });
  }),
);

// GET /api/accounts/:id/timeline  — merged lead + opportunity activity
router.get(
  '/:id/timeline',
  authorize('accounts.read'),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({
      where: { id: req.params.id },
      include: { leads: { select: { id: true } }, opportunities: { select: { id: true } } },
    });
    if (!account) throw notFound('Account not found');

    const leadIds = account.leads.map((l) => l.id);
    const oppIds = account.opportunities.map((o) => o.id);

    const [leadActivities, oppActivities] = await Promise.all([
      leadIds.length
        ? prisma.leadActivity.findMany({ where: { leadId: { in: leadIds } }, orderBy: { createdAt: 'desc' }, take: 50 })
        : Promise.resolve([]),
      oppIds.length
        ? prisma.opportunityActivity.findMany({ where: { opportunityId: { in: oppIds } }, orderBy: { createdAt: 'desc' }, take: 50 })
        : Promise.resolve([]),
    ]);

    const merged = [
      ...leadActivities.map((a) => ({ source: 'lead' as const, ...a })),
      ...oppActivities.map((a) => ({ source: 'opportunity' as const, ...a })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 50);

    res.json({ data: merged });
  }),
);

// PATCH /api/accounts/:id/kyc
const KYC_TRANSITIONS: Record<KycStatus, KycStatus[]> = {
  PENDING: [KycStatus.SUBMITTED],
  SUBMITTED: [KycStatus.VERIFIED, KycStatus.REJECTED],
  VERIFIED: [],
  REJECTED: [KycStatus.SUBMITTED],
};

router.patch(
  '/:id/kyc',
  authorize('accounts.kyc'),
  validate({ body: z.object({ kycStatus: z.enum(['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED']) }) }),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!account) throw notFound('Account not found');
    const next = req.body.kycStatus as KycStatus;
    if (!KYC_TRANSITIONS[account.kycStatus].includes(next)) {
      throw badRequest(`Illegal KYC transition ${account.kycStatus} → ${next}`);
    }
    const updated = await prisma.account.update({ where: { id: account.id }, data: { kycStatus: next } });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.STATUS_CHANGE,
      module: 'accounts',
      entity: 'Account',
      entityId: account.id,
      oldValue: { kycStatus: account.kycStatus },
      newValue: { kycStatus: next },
    });
    res.json(updated);
  }),
);

// PATCH /api/accounts/:id/empanel
router.patch(
  '/:id/empanel',
  authorize('accounts.empanel'),
  validate({
    body: z.object({
      empanelmentStatus: z.enum(['APPROVED', 'REJECTED']),
      commissionPercent: z.number().min(0).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({ where: { id: req.params.id } });
    if (!account) throw notFound('Account not found');
    if (account.type !== AccountType.CHANNEL_PARTNER) {
      throw badRequest('Empanelment applies only to CHANNEL_PARTNER accounts');
    }
    const b = req.body as { empanelmentStatus: 'APPROVED' | 'REJECTED'; commissionPercent?: number };

    const updated = await prisma.account.update({
      where: { id: account.id },
      data: {
        empanelmentStatus: b.empanelmentStatus as EmpanelmentStatus,
        empanelmentDate: new Date(),
        commissionPercent: b.commissionPercent != null ? b.commissionPercent : undefined,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.STATUS_CHANGE,
      module: 'accounts',
      entity: 'Account',
      entityId: account.id,
      oldValue: { empanelmentStatus: account.empanelmentStatus },
      newValue: { empanelmentStatus: b.empanelmentStatus, commissionPercent: b.commissionPercent },
    });
    res.json(updated);
  }),
);

export default router;
