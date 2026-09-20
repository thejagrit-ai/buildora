import { Router } from 'express';
import { z } from 'zod';
import { AuditAction, Prisma, UnitStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { authorize } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { writeAudit } from '../middleware/audit';
import { listQuerySchema, paginate, orderBy, pageMeta } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { notifyUser } from '../lib/notify';
import { env } from '../config/env';

const router = Router();

const UNIT_TYPES = [
  'ONE_BHK', 'TWO_BHK', 'THREE_BHK', 'FOUR_BHK', 'STUDIO', 'OFFICE', 'RETAIL', 'PLOT',
] as const;

const UNIT_STATUSES = [
  'AVAILABLE', 'BLOCKED', 'BOOKED', 'REGISTERED', 'CANCELLED',
] as const;

// Empty summary keyed by every UnitStatus value, used as a counter base.
function emptyStatusSummary(): Record<UnitStatus, number> {
  return {
    AVAILABLE: 0,
    BLOCKED: 0,
    BOOKED: 0,
    REGISTERED: 0,
    CANCELLED: 0,
  };
}

/**
 * Price components for a unit in paise.
 *
 * NOTE on Decimal handling: `superBuiltUpArea` is a Prisma `Decimal` (db Decimal(10,2)),
 * not a JS number. We convert it via `Number(...)` to multiply against the per-sqft
 * paise rate, then wrap the rounded product back into BigInt. This keeps the stored
 * money values as exact BigInt paise; the only float arithmetic is the area × rate
 * multiply, which is rounded immediately to avoid float drift.
 */
function unitPriceComponents(unit: {
  superBuiltUpArea: Prisma.Decimal;
  basePricePerSqftPaise: bigint;
  plcChargesPaise: bigint;
  floorRiseChargesPaise: bigint;
  carParkingChargesPaise: bigint;
}) {
  const area = Number(unit.superBuiltUpArea); // Decimal → number for the area×rate multiply
  const bspPaise = BigInt(Math.round(area * Number(unit.basePricePerSqftPaise)));
  const plcPaise = unit.plcChargesPaise;
  const floorRisePaise = unit.floorRiseChargesPaise;
  const parkingPaise = unit.carParkingChargesPaise;
  const totalPaise = bspPaise + plcPaise + floorRisePaise + parkingPaise;
  return {
    bspPaise,
    plcPaise,
    floorRisePaise,
    parkingPaise,
    // Pre-GST total cost of the unit.
    totalPaise,
  };
}

// ─── Projects ────────────────────────────────────────────────────────────────

const projectBody = z.object({
  name: z.string().min(2),
  type: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED']),
  location: z.string().min(1),
  reraNumber: z.string().min(1), // RERA registration is required for a listed project
  launchDate: z.coerce.date().optional(),
  possessionDate: z.coerce.date().optional(),
  totalUnits: z.number().int().nonnegative().default(0),
  amenities: z.array(z.string()).default([]),
});

// GET /api/inventory/projects
router.get(
  '/projects',
  authorize('inventory.read'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = req.query as never as z.infer<typeof listQuerySchema>;
    const where = {
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.project.findMany({
        where,
        ...paginate(q),
        orderBy: orderBy(q.sort),
        include: { _count: { select: { towers: true, units: true } } },
      }),
      prisma.project.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(total, q) });
  }),
);

// POST /api/inventory/projects
router.post(
  '/projects',
  authorize('inventory.create'),
  validate({ body: projectBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof projectBody>;
    const project = await prisma.project.create({
      data: {
        name: b.name,
        type: b.type,
        location: b.location,
        reraNumber: b.reraNumber,
        launchDate: b.launchDate,
        possessionDate: b.possessionDate,
        totalUnits: b.totalUnits,
        amenities: b.amenities,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'inventory', entity: 'Project', entityId: project.id, newValue: project });
    res.status(201).json(project);
  }),
);

// GET /api/inventory/projects/:id  — detail with towers + unit status summary counts
router.get(
  '/projects/:id',
  authorize('inventory.read'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { towers: true },
    });
    if (!project) throw notFound('Project not found');

    const grouped = await prisma.inventoryUnit.groupBy({
      by: ['status'],
      where: { projectId: project.id },
      _count: { _all: true },
    });
    const summary = emptyStatusSummary();
    let total = 0;
    for (const g of grouped) {
      summary[g.status] = g._count._all;
      total += g._count._all;
    }

    res.json({ ...project, statusSummary: { ...summary, total } });
  }),
);

// GET /api/inventory/projects/:id/inventory  — towers each with their units + summary
router.get(
  '/projects/:id/inventory',
  authorize('inventory.read'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw notFound('Project not found');

    const towers = await prisma.tower.findMany({
      where: { projectId: project.id },
      orderBy: { name: 'asc' },
      include: {
        units: { orderBy: [{ floor: 'asc' }, { unitNumber: 'asc' }] },
      },
    });

    const base = emptyStatusSummary();
    let total = 0;
    for (const t of towers) {
      for (const u of t.units) {
        base[u.status] += 1;
        total += 1;
      }
    }
    const summary = {
      available: base.AVAILABLE,
      blocked: base.BLOCKED,
      booked: base.BOOKED,
      registered: base.REGISTERED,
      cancelled: base.CANCELLED,
      total,
    };

    res.json({ project, towers, summary });
  }),
);

// GET /api/inventory/projects/:id/towers/:towerId/units  — floor × unit matrix friendly
router.get(
  '/projects/:id/towers/:towerId/units',
  authorize('inventory.read'),
  asyncHandler(async (req, res) => {
    const tower = await prisma.tower.findFirst({
      where: { id: req.params.towerId, projectId: req.params.id },
    });
    if (!tower) throw notFound('Tower not found');
    const units = await prisma.inventoryUnit.findMany({
      where: { towerId: tower.id },
      orderBy: [{ floor: 'asc' }, { unitNumber: 'asc' }],
    });
    res.json({ tower, data: units });
  }),
);

// ─── Towers ──────────────────────────────────────────────────────────────────

const towerBody = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1),
  floors: z.number().int().nonnegative().default(0),
  unitsPerFloor: z.number().int().nonnegative().default(0),
});

// POST /api/inventory/towers
router.post(
  '/towers',
  authorize('inventory.create'),
  validate({ body: towerBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof towerBody>;
    const project = await prisma.project.findUnique({ where: { id: b.projectId } });
    if (!project) throw notFound('Project not found');
    const tower = await prisma.tower.create({
      data: {
        projectId: b.projectId,
        name: b.name,
        floors: b.floors,
        unitsPerFloor: b.unitsPerFloor,
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'inventory', entity: 'Tower', entityId: tower.id, newValue: tower });
    res.status(201).json(tower);
  }),
);

// ─── Units ───────────────────────────────────────────────────────────────────

const unitBody = z.object({
  projectId: z.string().uuid(),
  towerId: z.string().uuid(),
  unitNumber: z.string().min(1),
  floor: z.number().int(),
  type: z.enum(UNIT_TYPES),
  superBuiltUpAreaSqft: z.number().positive(),
  carpetAreaSqft: z.number().positive(),
  facing: z.string().optional(),
  // Price components accepted as rupees, stored as BigInt paise.
  basePricePerSqftRupees: z.number().nonnegative().default(0),
  plcChargesRupees: z.number().nonnegative().default(0),
  floorRiseChargesRupees: z.number().nonnegative().default(0),
  carParkingChargesRupees: z.number().nonnegative().default(0),
});

// POST /api/inventory/units
router.post(
  '/units',
  authorize('inventory.create'),
  validate({ body: unitBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof unitBody>;
    const tower = await prisma.tower.findFirst({ where: { id: b.towerId, projectId: b.projectId } });
    if (!tower) throw notFound('Tower not found for project');

    const unit = await prisma.inventoryUnit.create({
      data: {
        projectId: b.projectId,
        towerId: b.towerId,
        unitNumber: b.unitNumber,
        floor: b.floor,
        type: b.type,
        superBuiltUpArea: new Prisma.Decimal(b.superBuiltUpAreaSqft),
        carpetArea: new Prisma.Decimal(b.carpetAreaSqft),
        facing: b.facing,
        basePricePerSqftPaise: BigInt(Math.round(b.basePricePerSqftRupees * 100)),
        plcChargesPaise: BigInt(Math.round(b.plcChargesRupees * 100)),
        floorRiseChargesPaise: BigInt(Math.round(b.floorRiseChargesRupees * 100)),
        carParkingChargesPaise: BigInt(Math.round(b.carParkingChargesRupees * 100)),
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.CREATE, module: 'inventory', entity: 'InventoryUnit', entityId: unit.id, newValue: unit });
    res.status(201).json(unit);
  }),
);

// GET /api/inventory/units/:id  — detail with computed priceSummary
router.get(
  '/units/:id',
  authorize('inventory.read'),
  asyncHandler(async (req, res) => {
    const unit = await prisma.inventoryUnit.findUnique({
      where: { id: req.params.id },
      include: { tower: { select: { name: true } }, project: { select: { name: true } } },
    });
    if (!unit) throw notFound('Unit not found');

    const c = unitPriceComponents(unit);
    const priceSummary = {
      bspPaise: c.bspPaise.toString(),
      plcChargesPaise: c.plcPaise.toString(),
      floorRiseChargesPaise: c.floorRisePaise.toString(),
      carParkingChargesPaise: c.parkingPaise.toString(),
      // Pre-GST total of base price + all add-on charges.
      preGstTotalPaise: c.totalPaise.toString(),
    };
    res.json({ ...unit, priceSummary });
  }),
);

// PATCH /api/inventory/units/:id/status
router.patch(
  '/units/:id/status',
  authorize('inventory.status'),
  validate({ body: z.object({ status: z.enum(UNIT_STATUSES) }) }),
  asyncHandler(async (req, res) => {
    const unit = await prisma.inventoryUnit.findUnique({ where: { id: req.params.id } });
    if (!unit) throw notFound('Unit not found');
    const next = req.body.status as UnitStatus;

    if (next === unit.status) {
      throw badRequest(`Unit is already ${next}`);
    }

    // Rule: only one active booking/block per unit. Moving INTO an "active"
    // state (BLOCKED/BOOKED/REGISTERED) requires the unit to currently be free.
    const ACTIVE: UnitStatus[] = ['BLOCKED', 'BOOKED', 'REGISTERED'];
    if (ACTIVE.includes(next) && ACTIVE.includes(unit.status)) {
      throw conflict(`Unit already has an active ${unit.status} state`);
    }

    // Clear hold metadata when the unit returns to a free/cancelled state.
    const clearsHold = next === 'AVAILABLE' || next === 'CANCELLED';
    const updated = await prisma.inventoryUnit.update({
      where: { id: unit.id },
      data: {
        status: next,
        ...(clearsHold ? { holdById: null, holdReason: null, holdExpiresAt: null } : {}),
      },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'inventory', entity: 'InventoryUnit', entityId: unit.id, oldValue: { status: unit.status }, newValue: { status: next } });
    res.json(updated);
  }),
);

// POST /api/inventory/units/:id/hold
router.post(
  '/units/:id/hold',
  authorize('inventory.hold'),
  validate({
    body: z.object({
      hours: z.number().positive().optional(),
      reason: z.string().min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body as { hours?: number; reason: string };
    const unit = await prisma.inventoryUnit.findUnique({ where: { id: req.params.id } });
    if (!unit) throw notFound('Unit not found');

    // Rule: only AVAILABLE units may be held.
    if (unit.status !== 'AVAILABLE') {
      throw conflict(`Cannot hold a ${unit.status} unit; only AVAILABLE units can be held`);
    }

    const hours = b.hours ?? env.DEFAULT_HOLD_HOURS;
    const holdExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const updated = await prisma.inventoryUnit.update({
      where: { id: unit.id },
      data: {
        status: 'BLOCKED',
        holdById: req.user!.id,
        holdReason: b.reason,
        holdExpiresAt,
      },
    });

    // Notify the holding agent (placeholder dispatch via notifyUser).
    await notifyUser({
      userId: req.user!.id,
      type: 'UNIT_HOLD',
      title: `Unit ${unit.unitNumber} held`,
      body: `You placed a ${hours}h hold on unit ${unit.unitNumber}. Expires ${holdExpiresAt.toISOString()}.`,
      link: `/inventory/units/${unit.id}`,
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'inventory', entity: 'InventoryUnit', entityId: unit.id, oldValue: { status: unit.status }, newValue: { status: 'BLOCKED', holdExpiresAt } });
    res.json(updated);
  }),
);

// DELETE /api/inventory/units/:id/hold  — release hold
router.delete(
  '/units/:id/hold',
  authorize('inventory.hold'),
  asyncHandler(async (req, res) => {
    const unit = await prisma.inventoryUnit.findUnique({ where: { id: req.params.id } });
    if (!unit) throw notFound('Unit not found');
    if (unit.status !== 'BLOCKED') {
      throw conflict('Unit is not currently held');
    }
    const updated = await prisma.inventoryUnit.update({
      where: { id: unit.id },
      data: { status: 'AVAILABLE', holdById: null, holdReason: null, holdExpiresAt: null },
    });
    await writeAudit({ userId: req.user!.id, action: AuditAction.STATUS_CHANGE, module: 'inventory', entity: 'InventoryUnit', entityId: unit.id, oldValue: { status: unit.status }, newValue: { status: 'AVAILABLE' } });
    res.json(updated);
  }),
);

// GET /api/inventory/units/:id/price-history
router.get(
  '/units/:id/price-history',
  authorize('inventory.read'),
  asyncHandler(async (req, res) => {
    const unit = await prisma.inventoryUnit.findUnique({ where: { id: req.params.id } });
    if (!unit) throw notFound('Unit not found');
    const revisions = await prisma.priceRevision.findMany({
      where: { unitId: unit.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: revisions });
  }),
);

// ─── Bulk pricing ──────────────────────────────────────────────────────────────

// Maps the API `field` token to the InventoryUnit price column.
const PRICE_FIELD_MAP = {
  base: 'basePricePerSqftPaise',
  plc: 'plcChargesPaise',
  floorRise: 'floorRiseChargesPaise',
  parking: 'carParkingChargesPaise',
} as const;

type PriceFieldKey = keyof typeof PRICE_FIELD_MAP;

// PUT /api/inventory/pricing/bulk
router.put(
  '/pricing/bulk',
  authorize('inventory.pricing'),
  validate({
    body: z.object({
      projectId: z.string().uuid(),
      field: z.enum(['base', 'plc', 'floorRise', 'parking']),
      newValueRupees: z.number().nonnegative(),
      effectiveAt: z.coerce.date(),
      towerId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body as {
      projectId: string;
      field: PriceFieldKey;
      newValueRupees: number;
      effectiveAt: Date;
      towerId?: string;
    };
    const column = PRICE_FIELD_MAP[b.field];
    const newValuePaise = BigInt(Math.round(b.newValueRupees * 100));

    // Price revisions never touch BOOKED / REGISTERED units (their pricing is locked).
    const targetWhere: Prisma.InventoryUnitWhereInput = {
      projectId: b.projectId,
      ...(b.towerId ? { towerId: b.towerId } : {}),
      status: { notIn: ['BOOKED', 'REGISTERED'] },
    };

    const result = await prisma.$transaction(async (tx) => {
      const units = await tx.inventoryUnit.findMany({ where: targetWhere });
      for (const u of units) {
        const oldValuePaise = u[column];
        await tx.inventoryUnit.update({
          where: { id: u.id },
          data: { [column]: newValuePaise },
        });
        await tx.priceRevision.create({
          data: {
            projectId: b.projectId,
            unitId: u.id,
            field: column,
            oldValuePaise,
            newValuePaise,
            effectiveAt: b.effectiveAt,
            revisedById: req.user!.id,
          },
        });
      }
      return { updated: units.length };
    });

    await writeAudit({ userId: req.user!.id, action: AuditAction.UPDATE, module: 'inventory', entity: 'InventoryUnit', entityId: b.projectId, newValue: { field: column, newValuePaise, towerId: b.towerId, count: result.updated } });
    res.json(result);
  }),
);

export default router;
