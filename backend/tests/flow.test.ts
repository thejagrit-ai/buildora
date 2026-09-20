// End-to-end happy path across the core lifecycle, exercised through the real
// HTTP surface (supertest) against a real Postgres:
//
//   login → create inventory → create lead → convert → verify KYC → book
//
// Asserts the cross-module business rules wire up: convert spawns an
// Account+Opportunity, KYC gates booking, and booking flips the unit to BOOKED
// and writes audit entries.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { reloadPermissions } from '../src/middleware/rbac';
import { PERMISSIONS } from '../src/config/permissions';

const app = createApp();
const agent = request(app);

let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  // Minimal RBAC seed: all permissions + a SUPER_ADMIN role + one admin user.
  await prisma.permission.createMany({
    data: PERMISSIONS.map((p) => ({ key: p.key, label: p.label, module: p.module })),
    skipDuplicates: true,
  });
  const perms = await prisma.permission.findMany();
  const role = await prisma.role.create({
    data: {
      name: 'SUPER_ADMIN',
      label: 'Super Admin',
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  const organization = await prisma.organization.create({ data: { name: `Flow Test ${Date.now()}`, slug: `flow-test-${Date.now()}` } });
  const organizationRole = await prisma.organizationRole.create({
    data: { organizationId: organization.id, key: 'SUPER_ADMIN', label: 'Super Admin', isSystem: true, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
  });
  const user = await prisma.user.create({
    data: {
      name: 'Test Admin',
      email: 'admin@test.com',
      passwordHash: bcrypt.hashSync('Passw0rd!', 10),
      roleId: role.id,
      defaultOrganizationId: organization.id,
    },
  });
  await prisma.membership.create({ data: { organizationId: organization.id, userId: user.id, roleId: role.id, organizationRoleId: organizationRole.id, status: 'ACTIVE' } });
  await reloadPermissions();

  const res = await agent.post('/api/auth/login').send({ email: 'admin@test.com', password: 'Passw0rd!' });
  expect(res.status).toBe(200);
  token = res.body.accessToken;
  expect(token).toBeTruthy();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('core lifecycle: lead → convert → booking', () => {
  let projectId: string;
  let towerId: string;
  let unitId: string;
  let leadId: string;
  let accountId: string;
  let opportunityId: string;

  it('rejects unauthenticated requests', async () => {
    const res = await agent.get('/api/leads');
    expect(res.status).toBe(401);
  });

  it('creates a project, tower and unit', async () => {
    const proj = await agent
      .post('/api/inventory/projects')
      .set(auth())
      .send({ name: 'Test Towers', type: 'RESIDENTIAL', location: 'Bengaluru', reraNumber: 'RERA/TEST/001' });
    expect(proj.status).toBe(201);
    projectId = proj.body.id;

    const tower = await agent
      .post('/api/inventory/towers')
      .set(auth())
      .send({ projectId, name: 'T1', floors: 5, unitsPerFloor: 4 });
    expect(tower.status).toBe(201);
    towerId = tower.body.id;

    const unit = await agent
      .post('/api/inventory/units')
      .set(auth())
      .send({
        projectId,
        towerId,
        unitNumber: 'T1-101',
        floor: 1,
        type: 'TWO_BHK',
        superBuiltUpAreaSqft: 1100,
        carpetAreaSqft: 770,
        basePricePerSqftRupees: 7500,
        plcChargesRupees: 150000,
      });
    expect(unit.status).toBe(201);
    unitId = unit.body.id;
    expect(unit.body.status).toBe('AVAILABLE');
  });

  it('creates a lead', async () => {
    const res = await agent
      .post('/api/leads')
      .set(auth())
      .send({ name: 'Anil Kumar', mobile: '9876500011', email: 'anil@example.com', sourceChannel: 'OTHER' });
    expect(res.status).toBe(201);
    leadId = res.body.id;
    expect(res.body.stage).toBe('NEW');
  });

  it('converts the lead into an account + opportunity', async () => {
    const res = await agent.post(`/api/leads/${leadId}/convert`).set(auth()).send({ projectId });
    expect(res.status).toBe(201);
    accountId = res.body.account.id;
    opportunityId = res.body.opportunity.id;
    expect(res.body.lead.stage).toBe('CONVERTED');
    expect(res.body.opportunity.probability).toBe(10);
  });

  it('blocks a booking until KYC is verified', async () => {
    const res = await agent
      .post('/api/bookings')
      .set(auth())
      .send({ accountId, unitId, projectId, bookingAmountRupees: 500000, totalValueRupees: 8250000, paymentMode: 'NEFT' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/KYC/i);
  });

  it('verifies KYC (PENDING → SUBMITTED → VERIFIED)', async () => {
    const s1 = await agent.patch(`/api/accounts/${accountId}/kyc`).set(auth()).send({ kycStatus: 'SUBMITTED' });
    expect(s1.status).toBe(200);
    const s2 = await agent.patch(`/api/accounts/${accountId}/kyc`).set(auth()).send({ kycStatus: 'VERIFIED' });
    expect(s2.status).toBe(200);
    expect(s2.body.kycStatus).toBe('VERIFIED');
  });

  it('creates a booking and flips the unit to BOOKED', async () => {
    const res = await agent
      .post('/api/bookings')
      .set(auth())
      .send({
        accountId,
        unitId,
        projectId,
        opportunityId,
        bookingAmountRupees: 500000,
        totalValueRupees: 8250000,
        paymentMode: 'NEFT',
      });
    expect(res.status).toBe(201);
    expect(res.body.bookingNumber).toMatch(/^BK-/);
    // Money is serialized as a string of paise.
    expect(res.body.bookingAmountPaise).toBe('50000000');

    const unit = await agent.get(`/api/inventory/units/${unitId}`).set(auth());
    expect(unit.body.status).toBe('BOOKED');
  });

  it('records an immutable audit trail for the mutations', async () => {
    const count = await prisma.auditLog.count();
    expect(count).toBeGreaterThan(0);
  });

  it('converts a lead to an Account only (no project / opportunity)', async () => {
    const lead = await agent
      .post('/api/leads')
      .set(auth())
      .send({ name: 'Meera Singh', mobile: '9876500022', sourceChannel: 'OTHER' });
    expect(lead.status).toBe(201);

    const res = await agent
      .post(`/api/leads/${lead.body.id}/convert`)
      .set(auth())
      .send({ salutation: 'Ms.', firstName: 'Meera', lastName: 'Singh' });
    expect(res.status).toBe(201);
    expect(res.body.account.name).toBe('Ms. Meera Singh');
    expect(res.body.account.type).toBe('INDIVIDUAL');
    expect(res.body.opportunity).toBeNull();
    expect(res.body.lead.stage).toBe('CONVERTED');
    expect(res.body.lead.opportunityId).toBeFalsy();
  });

  it('converts a lead into an existing Account', async () => {
    const lead = await agent
      .post('/api/leads')
      .set(auth())
      .send({ name: 'Repeat Buyer', mobile: '9876500033', sourceChannel: 'OTHER' });
    const res = await agent.post(`/api/leads/${lead.body.id}/convert`).set(auth()).send({ accountId });
    expect(res.status).toBe(201);
    expect(res.body.account.id).toBe(accountId);
    expect(res.body.opportunity).toBeNull();
    expect(res.body.lead.accountId).toBe(accountId);
  });
});
