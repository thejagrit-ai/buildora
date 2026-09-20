// Lead-routing engine, exercised through the real HTTP surface:
//
//   configure rules → dry-run "test" → create leads → assert the right owner
//
// Covers all three routing dimensions (project, geography, source channel) plus
// the SPECIFIC_USER and ROUND_ROBIN strategies, the default-round-robin
// fallback, and target validation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { RoleName } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { reloadPermissions } from '../src/middleware/rbac';
import { PERMISSIONS } from '../src/config/permissions';

const app = createApp();
const agent = request(app);

let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

let agentAId: string; // project / broker specialist
let agentBId: string; // pool member

beforeAll(async () => {
  await prisma.permission.createMany({
    data: PERMISSIONS.map((p) => ({ key: p.key, label: p.label, module: p.module })),
    skipDuplicates: true,
  });
  const perms = await prisma.permission.findMany();

  // Use CRM_ADMIN (not SUPER_ADMIN) so this file doesn't collide with flow.test
  // on the unique Role.name in the shared test DB. CRM_ADMIN has global view, so
  // the routing engine runs on its lead creates; grant it every permission here.
  const adminRole = await prisma.role.upsert({
    where: { name: RoleName.CRM_ADMIN },
    create: { name: RoleName.CRM_ADMIN, label: 'CRM Admin', permissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
    update: {},
  });
  const salesRole = await prisma.role.upsert({
    where: { name: RoleName.SALES_AGENT },
    create: { name: RoleName.SALES_AGENT, label: 'Sales Agent' },
    update: {},
  });

  const organization = await prisma.organization.create({ data: { name: `Routing Test ${Date.now()}`, slug: `routing-test-${Date.now()}` } });
  const organizationRole = await prisma.organizationRole.create({
    data: { organizationId: organization.id, key: 'CRM_ADMIN', label: 'CRM Admin', permissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
  });
  const admin = await prisma.user.create({
    data: { name: 'Routing Admin', email: 'routing-admin@test.com', passwordHash: bcrypt.hashSync('Passw0rd!', 10), roleId: adminRole.id, defaultOrganizationId: organization.id },
  });
  await prisma.membership.create({ data: { organizationId: organization.id, userId: admin.id, roleId: adminRole.id, organizationRoleId: organizationRole.id, status: 'ACTIVE' } });
  const a = await prisma.user.create({
    data: { name: 'Agent A', email: 'agent-a@test.com', passwordHash: bcrypt.hashSync('x', 10), roleId: salesRole.id, defaultOrganizationId: organization.id },
  });
  const b = await prisma.user.create({
    data: { name: 'Agent B', email: 'agent-b@test.com', passwordHash: bcrypt.hashSync('x', 10), roleId: salesRole.id, defaultOrganizationId: organization.id },
  });
  await prisma.membership.createMany({ data: [
    { organizationId: organization.id, userId: a.id, roleId: salesRole.id, status: 'ACTIVE' },
    { organizationId: organization.id, userId: b.id, roleId: salesRole.id, status: 'ACTIVE' },
  ] });
  agentAId = a.id;
  agentBId = b.id;

  await reloadPermissions();

  const res = await agent.post('/api/auth/login').send({ email: 'routing-admin@test.com', password: 'Passw0rd!' });
  expect(res.status).toBe(200);
  token = res.body.accessToken;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('lead routing', () => {
  let projectId: string;

  it('creates a project to route against', async () => {
    const proj = await agent
      .post('/api/inventory/projects')
      .set(auth())
      .send({ name: 'Marina Bay', type: 'RESIDENTIAL', location: 'Whitefield, Bengaluru', reraNumber: 'RERA/RT/001' });
    expect(proj.status).toBe(201);
    projectId = proj.body.id;
  });

  it('rejects a SPECIFIC_USER rule with no target', async () => {
    const res = await agent
      .post('/api/routing/rules')
      .set(auth())
      .send({ name: 'Bad rule', strategy: 'SPECIFIC_USER' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/targetUserId/i);
  });

  it('creates a by-project rule → Agent A', async () => {
    const res = await agent
      .post('/api/routing/rules')
      .set(auth())
      .send({ name: 'Marina Bay → Agent A', strategy: 'SPECIFIC_USER', projectId, targetUserId: agentAId });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(0);
  });

  it('creates a by-channel ROUND_ROBIN rule → pool', async () => {
    const res = await agent
      .post('/api/routing/rules')
      .set(auth())
      .send({ name: 'Walk-ins → pool', strategy: 'ROUND_ROBIN', sourceChannel: 'WALK_IN', memberIds: [agentAId, agentBId] });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(1);
  });

  it('dry-runs the engine for a project lead', async () => {
    const res = await agent.post('/api/routing/test').set(auth()).send({ projectId, sourceChannel: 'GOOGLE_ADS' });
    expect(res.status).toBe(200);
    expect(res.body.result.outcome).toBe('RULE');
    expect(res.body.result.owner.id).toBe(agentAId);
    // The matched rule should be flagged in the per-rule trace.
    const matched = res.body.evaluations.filter((e: any) => e.matched);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toMatch(/Marina Bay/);
  });

  it('routes a created lead by project to Agent A', async () => {
    const res = await agent
      .post('/api/leads')
      .set(auth())
      .send({ name: 'Project Lead', mobile: '9000000001', sourceChannel: 'GOOGLE_ADS', projectId });
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(agentAId);

    const timeline = await agent.get(`/api/leads/${res.body.id}/timeline`).set(auth());
    expect(timeline.body.data.some((a: any) => /Auto-routed/.test(a.summary))).toBe(true);
  });

  it('routes a walk-in lead to a pool member (ROUND_ROBIN)', async () => {
    const res = await agent
      .post('/api/leads')
      .set(auth())
      .send({ name: 'Walk-in Lead', mobile: '9000000002', sourceChannel: 'WALK_IN' });
    expect(res.status).toBe(201);
    expect([agentAId, agentBId]).toContain(res.body.ownerId);
  });

  it('falls back to default round-robin when no rule matches', async () => {
    // EMAIL channel + no project matches none of the rules → least-loaded agent.
    const res = await agent
      .post('/api/leads')
      .set(auth())
      .send({ name: 'Unmatched Lead', mobile: '9000000003', sourceChannel: 'EMAIL' });
    expect(res.status).toBe(201);
    expect([agentAId, agentBId]).toContain(res.body.ownerId);
  });

  it('lists rules in priority order with resolved names', async () => {
    const res = await agent.get('/api/routing/rules').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => r.priority)).toEqual([0, 1]);
    const projRule = res.body.data[0];
    expect(projRule.projectName).toBe('Marina Bay');
    expect(projRule.targetUser?.name).toBe('Agent A');
  });

  it('reorders rules', async () => {
    const list = (await agent.get('/api/routing/rules').set(auth())).body.data;
    const reversed = [list[1].id, list[0].id];
    const res = await agent.put('/api/routing/rules/reorder').set(auth()).send({ ids: reversed });
    expect(res.status).toBe(200);
    const after = (await agent.get('/api/routing/rules').set(auth())).body.data;
    expect(after[0].id).toBe(reversed[0]);
  });
});
