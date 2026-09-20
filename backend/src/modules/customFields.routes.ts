import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, CustomFieldType, CustomObjectType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { badRequest, conflict, notFound } from '../lib/errors';

const router = Router();

const OBJECT_TYPES = ['ACCOUNT', 'OPPORTUNITY', 'LEAD', 'SITE_VISIT'] as const;
const FIELD_TYPES = [
  'TEXT', 'TEXTAREA', 'NUMBER', 'CURRENCY', 'PERCENT', 'CHECKBOX',
  'DATE', 'DATETIME', 'EMAIL', 'PHONE', 'URL', 'PICKLIST',
] as const;

const objectTypeEnum = z.enum(OBJECT_TYPES);
const fieldTypeEnum = z.enum(FIELD_TYPES);

// Turn a human label into a stable snake_case api name (the value key).
function toApiName(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  const safe = /^[a-z]/.test(base) ? base : `f_${base}`;
  return safe.slice(0, 60) || 'field';
}

// Coerce/validate one incoming value against a field's type. Returns the value
// to store (JSON-serialisable) or throws a 400. `null`/'' clears the value.
function coerceValue(field: { fieldType: CustomFieldType; label: string; options: unknown }, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (field.fieldType) {
    case 'NUMBER':
    case 'CURRENCY':
    case 'PERCENT': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(n)) throw badRequest(`${field.label} must be a number`);
      return n;
    }
    case 'CHECKBOX':
      return raw === true || raw === 'true';
    case 'EMAIL': {
      const s = String(raw);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`${field.label} must be a valid email`);
      return s;
    }
    case 'URL': {
      const s = String(raw);
      try { new URL(s); } catch { throw badRequest(`${field.label} must be a valid URL`); }
      return s;
    }
    case 'PICKLIST': {
      const s = String(raw);
      const opts = Array.isArray(field.options) ? (field.options as string[]) : [];
      if (opts.length && !opts.includes(s)) throw badRequest(`${field.label}: "${s}" is not an allowed option`);
      return s;
    }
    case 'DATE':
    case 'DATETIME':
      return String(raw); // stored as the ISO string the client sends
    default:
      return String(raw);
  }
}

// ── Field definitions ────────────────────────────────────────────────────────

// GET /custom-fields/definitions?objectType=LEAD[&all=true]
// Any authenticated user can read definitions (forms need them to render).
router.get(
  '/definitions',
  validate({ query: z.object({ objectType: objectTypeEnum, all: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const { objectType, all } = req.query as unknown as { objectType: CustomObjectType; all?: string };
    const includeInactive = all === 'true' && req.user!.permissions.has('admin.config');
    const defs = await prisma.customFieldDefinition.findMany({
      where: { objectType, ...(includeInactive ? {} : { active: true }) },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(defs);
  }),
);

const defBodySchema = z.object({
  objectType: objectTypeEnum,
  label: z.string().min(1).max(80),
  apiName: z.string().max(60).optional(),
  fieldType: fieldTypeEnum,
  required: z.boolean().optional(),
  options: z.array(z.string().min(1)).optional(),
  helpText: z.string().max(255).optional(),
  order: z.number().int().optional(),
  active: z.boolean().optional(),
});

// POST /custom-fields/definitions — create a field (Super Admin / admin.config).
router.post(
  '/definitions',
  authorize('admin.config'),
  validate({ body: defBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof defBodySchema>;
    if (body.fieldType === 'PICKLIST' && (!body.options || body.options.length === 0)) {
      throw badRequest('Picklist fields require at least one option');
    }
    const apiName = body.apiName ? toApiName(body.apiName) : toApiName(body.label);
    const exists = await prisma.customFieldDefinition.findUnique({
      where: { organizationId_objectType_apiName: { organizationId: req.user!.organizationId!, objectType: body.objectType, apiName } },
    });
    if (exists) throw conflict(`A field with api name "${apiName}" already exists on ${body.objectType}`);

    const created = await prisma.customFieldDefinition.create({
      data: {
        objectType: body.objectType,
        label: body.label,
        apiName,
        fieldType: body.fieldType,
        required: body.required ?? false,
        options: body.fieldType === 'PICKLIST' ? (body.options as Prisma.InputJsonValue) : Prisma.JsonNull,
        helpText: body.helpText,
        order: body.order ?? 0,
        active: body.active ?? true,
        createdById: req.user!.id,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.CREATE,
      module: 'admin',
      entity: 'CustomFieldDefinition',
      entityId: created.id,
      newValue: created,
    });
    res.status(201).json(created);
  }),
);

// PUT /custom-fields/definitions/reorder — set display order from an ordered id
// list (page-layout ordering). Declared before the ":id" routes so the literal
// path matches first.
router.put(
  '/definitions/reorder',
  authorize('admin.config'),
  validate({ body: z.object({ objectType: objectTypeEnum, ids: z.array(z.string().uuid()) }) }),
  asyncHandler(async (req, res) => {
    const { objectType, ids } = req.body as { objectType: CustomObjectType; ids: string[] };
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.customFieldDefinition.updateMany({
          where: { id, objectType }, // scoped to the object so other objects are untouched
          data: { order: index },
        }),
      ),
    );
    const defs = await prisma.customFieldDefinition.findMany({
      where: { objectType },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(defs);
  }),
);

// PATCH /custom-fields/definitions/:id — update label/options/required/order/active.
// apiName and fieldType are immutable to avoid orphaning stored values.
router.patch(
  '/definitions/:id',
  authorize('admin.config'),
  validate({
    body: z.object({
      label: z.string().min(1).max(80).optional(),
      required: z.boolean().optional(),
      options: z.array(z.string().min(1)).optional(),
      helpText: z.string().max(255).nullable().optional(),
      order: z.number().int().optional(),
      active: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const before = await prisma.customFieldDefinition.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Field not found');
    const body = req.body as Record<string, unknown>;
    if (before.fieldType === 'PICKLIST' && body.options !== undefined && (body.options as string[]).length === 0) {
      throw badRequest('Picklist fields require at least one option');
    }
    const updated = await prisma.customFieldDefinition.update({
      where: { id: before.id },
      data: {
        label: body.label as string | undefined,
        required: body.required as boolean | undefined,
        options: body.options !== undefined ? (body.options as Prisma.InputJsonValue) : undefined,
        helpText: body.helpText === null ? null : (body.helpText as string | undefined),
        order: body.order as number | undefined,
        active: body.active as boolean | undefined,
      },
    });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.UPDATE,
      module: 'admin',
      entity: 'CustomFieldDefinition',
      entityId: updated.id,
      oldValue: before,
      newValue: updated,
    });
    res.json(updated);
  }),
);

// DELETE /custom-fields/definitions/:id — removes the field and its stored values.
router.delete(
  '/definitions/:id',
  authorize('admin.config'),
  asyncHandler(async (req, res) => {
    const before = await prisma.customFieldDefinition.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Field not found');
    await prisma.customFieldDefinition.delete({ where: { id: before.id } });
    await writeAudit({
      userId: req.user!.id,
      action: AuditAction.DELETE,
      module: 'admin',
      entity: 'CustomFieldDefinition',
      entityId: before.id,
      oldValue: before,
    });
    res.status(204).end();
  }),
);

// ── Field values (per record) ────────────────────────────────────────────────

// GET /custom-fields/values/:objectType/:recordId — { apiName: value } map.
router.get(
  '/values/:objectType/:recordId',
  validate({ params: z.object({ objectType: objectTypeEnum, recordId: z.string().min(1).max(64) }) }),
  asyncHandler(async (req, res) => {
    const { objectType, recordId } = req.params as unknown as { objectType: CustomObjectType; recordId: string };
    const defs = await prisma.customFieldDefinition.findMany({ where: { objectType, active: true } });
    const values = await prisma.customFieldValue.findMany({
      where: { recordId, fieldId: { in: defs.map((d) => d.id) } },
    });
    const byField = new Map(values.map((v) => [v.fieldId, v.value]));
    const out: Record<string, unknown> = {};
    for (const d of defs) out[d.apiName] = byField.has(d.id) ? byField.get(d.id) : null;
    res.json(out);
  }),
);

// PUT /custom-fields/values/:objectType/:recordId — upsert a { apiName: value } map.
// Requires update permission on the owning object's module.
const OBJECT_PERM: Record<CustomObjectType, string> = {
  ACCOUNT: 'accounts.update',
  OPPORTUNITY: 'opportunities.update',
  LEAD: 'leads.update',
  SITE_VISIT: 'siteVisits.update',
};

router.put(
  '/values/:objectType/:recordId',
  validate({
    params: z.object({ objectType: objectTypeEnum, recordId: z.string().min(1).max(64) }),
    body: z.object({ values: z.record(z.unknown()) }),
  }),
  asyncHandler(async (req, res) => {
    const { objectType, recordId } = req.params as unknown as { objectType: CustomObjectType; recordId: string };
    const perm = OBJECT_PERM[objectType];
    if (!req.user!.permissions.has(perm)) {
      throw badRequest('Not allowed to update this record');
    }
    const { values } = req.body as { values: Record<string, unknown> };
    const defs = await prisma.customFieldDefinition.findMany({ where: { objectType, active: true } });
    const byApiName = new Map(defs.map((d) => [d.apiName, d]));

    await prisma.$transaction(
      Object.entries(values)
        .filter(([apiName]) => byApiName.has(apiName))
        .map(([apiName, raw]) => {
          const def = byApiName.get(apiName)!;
          const value = coerceValue(def, raw) as Prisma.InputJsonValue | null;
          return prisma.customFieldValue.upsert({
            where: { fieldId_recordId: { fieldId: def.id, recordId } },
            create: { fieldId: def.id, recordId, value: value ?? Prisma.JsonNull },
            update: { value: value ?? Prisma.JsonNull },
          });
        }),
    );

    // Return the refreshed map so the client can reflect coerced values.
    const stored = await prisma.customFieldValue.findMany({
      where: { recordId, fieldId: { in: defs.map((d) => d.id) } },
    });
    const byField = new Map(stored.map((v) => [v.fieldId, v.value]));
    const out: Record<string, unknown> = {};
    for (const d of defs) out[d.apiName] = byField.has(d.id) ? byField.get(d.id) : null;
    res.json(out);
  }),
);

export default router;
