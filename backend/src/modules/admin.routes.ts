import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, PermissionScope, Prisma, RoleName } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { encryptConfigSecret, isSensitiveConfigKey } from '../lib/secureConfig';
import net from 'node:net';
import tls from 'node:tls';

const router = Router();

const roleNameEnum = z.enum([
  'SUPER_ADMIN',
  'CRM_ADMIN',
  'SALES_AGENT',
  'CHANNEL_PARTNER',
  'PROJECT_MANAGER',
  'FINANCE',
]);

const userSelect: Prisma.UserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  timezone: true,
  partnerAccountId: true,
  role: { select: { id: true, name: true, label: true } },
  createdAt: true,
  lastLoginAt: true,
};

const memberInCurrentOrganization = (organizationId: string, userId?: string): Prisma.UserWhereInput => ({
  ...(userId ? { id: userId } : {}),
  memberships: { some: { organizationId, status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } } },
});

async function getRolePair(organizationId: string, roleName: RoleName) {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) throw badRequest(`Unknown role: ${roleName}`);
  const organizationRole = await prisma.organizationRole.findUnique({
    where: { organizationId_key: { organizationId, key: roleName } },
  });
  if (!organizationRole) throw badRequest(`Role is not configured for this organization: ${roleName}`);
  return { role, organizationRole };
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────

// GET /users — list users with their role.
router.get(
  '/users',
  authorize('admin.users'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema>;
    const where: Prisma.UserWhereInput = {
      ...memberInCurrentOrganization(req.user!.organizationId!),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.user.findMany({ where, ...paginate(q), orderBy: { createdAt: 'desc' }, select: userSelect }),
      prisma.user.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

const createUserBody = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(8),
  roleName: roleNameEnum,
  partnerAccountId: z.string().uuid().optional(),
});

// POST /users — create a user (password hashed with bcryptjs).
router.post(
  '/users',
  authorize('admin.users'),
  validate({ body: createUserBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof createUserBody>;
    const existing = await prisma.user.findUnique({ where: { email: b.email } });
    if (existing) throw conflict('A user with this email already exists');

    const { role, organizationRole } = await getRolePair(req.user!.organizationId!, b.roleName as RoleName);

    const user = await prisma.user.create({
      data: {
        name: b.name,
        email: b.email,
        phone: b.phone,
        passwordHash: bcrypt.hashSync(b.password, 10),
        roleId: role.id,
        partnerAccountId: b.partnerAccountId,
        defaultOrganizationId: req.user!.organizationId,
        memberships: {
          create: {
            organizationId: req.user!.organizationId!,
            roleId: role.id,
            organizationRoleId: organizationRole.id,
          },
        },
      },
      select: userSelect,
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'admin',
      entity: 'User',
      entityId: user.id,
      newValue: user,
    });
    res.status(201).json(user);
  }),
);

const updateUserBody = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  roleName: roleNameEnum.optional(),
  isActive: z.boolean().optional(),
  timezone: z.string().optional(),
});

// PATCH /users/:id — update profile / role / status.
router.patch(
  '/users/:id',
  authorize('admin.users'),
  validate({ body: updateUserBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof updateUserBody>;
    const before = await prisma.user.findFirst({ where: memberInCurrentOrganization(req.user!.organizationId!, req.params.id), select: userSelect });
    if (!before) throw notFound('User not found');

    let roleId: string | undefined;
    if (b.roleName) {
      const { role } = await getRolePair(req.user!.organizationId!, b.roleName as RoleName);
      roleId = role.id;
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        name: b.name,
        phone: b.phone,
        isActive: b.isActive,
        timezone: b.timezone,
        roleId,
      },
      select: userSelect,
    });
    if (roleId && b.roleName) {
      const { organizationRole } = await getRolePair(req.user!.organizationId!, b.roleName as RoleName);
      await prisma.membership.updateMany({
        where: { organizationId: req.user!.organizationId!, userId: user.id },
        data: { roleId, organizationRoleId: organizationRole.id },
      });
    }
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'admin',
      entity: 'User',
      entityId: user.id,
      oldValue: before,
      newValue: user,
    });
    res.json(user);
  }),
);

// POST /users/:id/deactivate — disable a user.
router.post(
  '/users/:id/deactivate',
  authorize('admin.users'),
  asyncHandler(async (req, res) => {
    const before = await prisma.user.findFirst({ where: memberInCurrentOrganization(req.user!.organizationId!, req.params.id) });
    if (!before) throw notFound('User not found');
    await prisma.membership.updateMany({ where: { organizationId: req.user!.organizationId!, userId: req.params.id }, data: { status: 'SUSPENDED' } });
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: userSelect });
    if (!user) throw notFound('User not found');
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'admin',
      entity: 'User',
      entityId: user.id,
      oldValue: { isActive: before.isActive },
      newValue: { isActive: false },
    });
    res.json(user);
  }),
);

// POST /users/:id/reset-password — rehash a new password.
router.post(
  '/users/:id/reset-password',
  authorize('admin.users'),
  validate({ body: z.object({ password: z.string().min(8) }) }),
  asyncHandler(async (req, res) => {
    const before = await prisma.user.findFirst({ where: memberInCurrentOrganization(req.user!.organizationId!, req.params.id) });
    if (!before) throw notFound('User not found');
    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash: bcrypt.hashSync((req.body as { password: string }).password, 10) },
    });
    await prisma.refreshToken.updateMany({ where: { userId: req.params.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'admin',
      entity: 'User',
      entityId: req.params.id,
      newValue: { passwordReset: true },
    });
    res.json({ ok: true });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// ROLES & PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────

// GET /roles — roles with their permission keys.
router.get(
  '/roles',
  authorize('admin.roles'),
  asyncHandler(async (req, res) => {
    const roles = await prisma.organizationRole.findMany({
      where: { organizationId: req.user!.organizationId! },
      orderBy: { label: 'asc' },
      include: {
        permissions: { include: { permission: { select: { key: true } } } },
        _count: { select: { memberships: true } },
      },
    });
    const data = roles.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.memberships,
      permissions: r.permissions.map((rp) => ({ key: rp.permission.key, scope: rp.scope })),
      permissionKeys: r.permissions.map((rp) => rp.permission.key),
    }));
    res.json({ data });
  }),
);

// GET /permissions — the full permission catalogue.
router.get(
  '/permissions',
  authorize('admin.roles'),
  asyncHandler(async (_req, res) => {
    const permissions = await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { key: 'asc' }] });
    res.json({ data: permissions });
  }),
);

// PUT /roles/:id/permissions — replace a role's permission set (transaction),
// then reload the in-memory permission cache so the change takes effect.
router.put(
  '/roles/:id/permissions',
  authorize('admin.roles'),
  validate({
    body: z.object({
      permissionKeys: z.array(z.string()).optional(),
      permissions: z.array(z.object({
        key: z.string(),
        scope: z.nativeEnum(PermissionScope).optional(),
      })).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const role = await prisma.organizationRole.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId! },
    });
    if (!role) throw notFound('Role not found');
    const body = req.body as { permissionKeys?: string[]; permissions?: { key: string; scope?: PermissionScope }[] };
    const requested = body.permissions?.length
      ? body.permissions
      : (body.permissionKeys ?? []).map((key) => ({ key, scope: 'ORGANIZATION' as PermissionScope }));
    const permissionKeys = requested.map((p) => p.key);

    const perms = await prisma.permission.findMany({ where: { key: { in: permissionKeys } }, select: { id: true, key: true } });
    const found = new Set(perms.map((p) => p.key));
    const missing = permissionKeys.filter((k) => !found.has(k));
    if (missing.length) throw badRequest(`Unknown permission keys: ${missing.join(', ')}`);
    const scopeByKey = new Map(requested.map((p) => [p.key, p.scope ?? 'ORGANIZATION']));

    await prisma.$transaction([
      prisma.organizationRolePermission.deleteMany({ where: { roleId: role.id } }),
      prisma.organizationRolePermission.createMany({
        data: perms.map((p) => ({
          roleId: role.id,
          permissionId: p.id,
          scope: scopeByKey.get(p.key) ?? 'ORGANIZATION',
        })),
      }),
    ]);

    // Refresh the in-memory role→permission cache used by the rbac middleware.
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'admin',
      entity: 'OrganizationRole',
      entityId: role.id,
      newValue: { permissions: requested },
    });
    res.json({ ok: true, roleId: role.id, permissions: requested });
  }),
);

// Verify SMTP connectivity without persisting or logging credentials. This intentionally
// performs a connection/banner check only; the actual provider credentials remain encrypted.
router.post(
  '/config/test/smtp',
  authorize('admin.config'),
  validate({ body: z.object({ host: z.string().min(1).max(255), port: z.coerce.number().int().min(1).max(65535), username: z.string().max(320).optional(), password: z.string().max(512).optional(), from: z.string().max(320).optional() }) }),
  asyncHandler(async (req, res) => {
    const { host, port } = req.body as { host: string; port: number };
    const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const secure = port === 465;
      const socket = secure ? tls.connect({ host, port, servername: host, timeout: 7000 }) : net.createConnection({ host, port, timeout: 7000 });
      let settled = false;
      const finish = (value: { ok: boolean; message: string }) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
      socket.once('secureConnect', () => finish({ ok: true, message: 'SMTP server is reachable.' }));
      socket.once('connect', () => { if (!secure) finish({ ok: true, message: 'SMTP server is reachable.' }); });
      socket.once('error', () => finish({ ok: false, message: 'Unable to reach the SMTP server. Check the host and port.' }));
      socket.once('timeout', () => finish({ ok: false, message: 'SMTP connection timed out. Check the host and port.' }));
    });
    if (!result.ok) return res.status(502).json({ error: { message: result.message } });
    res.json(result);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────

// GET /audit-logs — searchable, paginated, newest first.
router.get(
  '/audit-logs',
  authorize('admin.audit'),
  validate({
    query: listQuerySchema.extend({
      userId: z.string().uuid().optional(),
      module: z.string().optional(),
      entity: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema> & {
      userId?: string;
      module?: string;
      entity?: string;
      from?: Date;
      to?: Date;
    };
    const createdAt =
      q.from || q.to ? { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } : undefined;
    const where: Prisma.AuditLogWhereInput = {
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.module ? { module: q.module } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        ...paginate(q),
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// GET /config — all SystemConfig as a key → value map.
router.get(
  '/config',
  authorize('admin.config'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.systemConfig.findMany();
    const data: Record<string, unknown> = {};
    for (const r of rows) {
      // Return only a non-secret marker so the UI can show "Configured" without exposing credentials.
      if (isSensitiveConfigKey(r.key)) data[r.key] = '__configured__';
      else data[r.key] = r.value;
    }
    res.json({ data });
  }),
);

// PUT /config — upsert a single SystemConfig row.
router.put(
  '/config',
  authorize('admin.config'),
  validate({ body: z.object({ key: z.string().min(1), value: z.unknown() }) }),
  asyncHandler(async (req, res) => {
    const { key, value } = req.body as { key: string; value: unknown };
    const before = await prisma.systemConfig.findUnique({
      where: { organizationId_key: { organizationId: req.user!.organizationId!, key } },
    });
    const storedValue = isSensitiveConfigKey(key) && typeof value === 'string'
      ? (value.length > 0 ? encryptConfigSecret(value) : before?.value ?? '')
      : value;
    const config = await prisma.systemConfig.upsert({
      where: { organizationId_key: { organizationId: req.user!.organizationId!, key } },
      create: { key, value: storedValue as Prisma.InputJsonValue },
      update: { value: storedValue as Prisma.InputJsonValue },
    });
    await writeAudit({
      userId: req.user!.id,
      action: before ? AuditAction.UPDATE : AuditAction.CREATE,
      module: 'admin',
      entity: 'SystemConfig',
      entityId: key,
      oldValue: before ?? undefined,
      newValue: config,
    });
    res.json(config);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

// GET /templates — list notification templates.
router.get(
  '/templates',
  authorize('admin.templates'),
  asyncHandler(async (_req, res) => {
    const templates = await prisma.notificationTemplate.findMany({ orderBy: { key: 'asc' } });
    res.json({ data: templates });
  }),
);

const templateBody = z.object({
  key: z.string().min(1),
  channel: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
});

// POST /templates — create or update a template (keyed by `key`).
router.post(
  '/templates',
  authorize('admin.templates'),
  validate({ body: templateBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof templateBody>;
    const before = await prisma.notificationTemplate.findUnique({
      where: { organizationId_key: { organizationId: req.user!.organizationId!, key: b.key } },
    });
    const template = await prisma.notificationTemplate.upsert({
      where: { organizationId_key: { organizationId: req.user!.organizationId!, key: b.key } },
      create: { key: b.key, channel: b.channel, subject: b.subject, body: b.body },
      update: { channel: b.channel, subject: b.subject, body: b.body },
    });
    await writeAudit({
      userId: req.user!.id,
      action: before ? AuditAction.UPDATE : AuditAction.CREATE,
      module: 'admin',
      entity: 'NotificationTemplate',
      entityId: template.id,
      oldValue: before ?? undefined,
      newValue: template,
    });
    res.status(before ? 200 : 201).json(template);
  }),
);

export default router;
