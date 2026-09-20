import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { RoleName } from '@prisma/client';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { reloadPermissions } from '../src/middleware/rbac';
import { PERMISSIONS } from '../src/config/permissions';

const app = createApp();
const agent = request(app);
let tokenA = '';
let projectA = '';
let projectB = '';

describe('tenant isolation', () => {
  beforeAll(async () => {
    await prisma.permission.createMany({ data: PERMISSIONS.map((p) => ({ key: p.key, label: p.label, module: p.module })), skipDuplicates: true });
    const permissions = await prisma.permission.findMany();
    const role = await prisma.role.upsert({
      where: { name: RoleName.SUPER_ADMIN },
      create: { name: RoleName.SUPER_ADMIN, label: 'Test administrator', permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
      update: {},
    });
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({ data: { name: 'Aster Developments', slug: `aster-${Date.now()}` } }),
      prisma.organization.create({ data: { name: 'Banyan Developments', slug: `banyan-${Date.now()}` } }),
    ]);
    const passwordHash = await bcrypt.hash('TenantPassw0rd!', 10);
    const [userA, userB] = await Promise.all([
      prisma.user.create({ data: { name: 'A user', email: `a-${Date.now()}@tenant.test`, passwordHash, roleId: role.id, defaultOrganizationId: orgA.id } }),
      prisma.user.create({ data: { name: 'B user', email: `b-${Date.now()}@tenant.test`, passwordHash, roleId: role.id, defaultOrganizationId: orgB.id } }),
    ]);
    await prisma.membership.createMany({ data: [
      { organizationId: orgA.id, userId: userA.id, roleId: role.id },
      { organizationId: orgB.id, userId: userB.id, roleId: role.id },
    ] });
    [projectA, projectB] = await Promise.all([
      prisma.project.create({ data: { name: 'Aster One', type: 'RESIDENTIAL', location: 'Test City', reraNumber: `A-${Date.now()}`, organizationId: orgA.id } }).then((p) => p.id),
      prisma.project.create({ data: { name: 'Banyan One', type: 'RESIDENTIAL', location: 'Test City', reraNumber: `B-${Date.now()}`, organizationId: orgB.id } }).then((p) => p.id),
    ]);
    await reloadPermissions();
    const login = await agent.post('/api/auth/login').send({ email: userA.email, password: 'TenantPassw0rd!' });
    expect(login.status).toBe(200);
    tokenA = login.body.accessToken;
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('lists only the current organization’s projects', async () => {
    const response = await agent.get('/api/inventory/projects').set('Authorization', `Bearer ${tokenA}`);
    expect(response.status).toBe(200);
    expect(response.body.data.map((project: { id: string }) => project.id)).toContain(projectA);
    expect(response.body.data.map((project: { id: string }) => project.id)).not.toContain(projectB);
  });

  it('does not reveal another organization’s project by ID', async () => {
    const response = await agent.get(`/api/inventory/projects/${projectB}`).set('Authorization', `Bearer ${tokenA}`);
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Project not found');
  });
});
