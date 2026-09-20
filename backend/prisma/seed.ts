/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaClient, RoleName, Prisma, PermissionScope } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLE_MATRIX } from '../src/config/permissions';

const prisma = new PrismaClient();

const ROLE_LABELS: Record<RoleName, string> = {
  SUPER_ADMIN: 'Super Admin',
  CRM_ADMIN: 'CRM Admin',
  SALES_AGENT: 'Sales Agent',
  CHANNEL_PARTNER: 'Channel Partner / Broker',
  PROJECT_MANAGER: 'Project Manager',
  FINANCE: 'Finance Team',
};

const ROLE_SCOPES: Partial<Record<RoleName, PermissionScope>> = {
  SALES_AGENT: 'ASSIGNED',
  CHANNEL_PARTNER: 'OWNED',
  PROJECT_MANAGER: 'PROJECT',
};

// Expand wildcard grants ("leads.*") against the permission catalogue.
function expandGrants(grants: string[]): Set<string> {
  if (grants.includes('*')) return new Set(PERMISSIONS.map((p) => p.key));
  const out = new Set<string>();
  for (const g of grants) {
    if (g.endsWith('.*')) {
      const mod = g.slice(0, -2);
      PERMISSIONS.filter((p) => p.module === mod).forEach((p) => out.add(p.key));
    } else {
      out.add(g);
    }
  }
  return out;
}

const R = (rupees: number) => BigInt(Math.round(rupees * 100));

async function main() {
  console.log('🌱 Seeding Buildora demo workspace...');

  // ── Permissions ──
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, label: p.label, module: p.module },
      update: { label: p.label, module: p.module },
    });
  }
  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  // ── Roles + role→permission ──
  const roleIds: Partial<Record<RoleName, string>> = {};
  for (const name of Object.keys(ROLE_MATRIX) as RoleName[]) {
    const role = await prisma.role.upsert({
      where: { name },
      create: { name, label: ROLE_LABELS[name] },
      update: { label: ROLE_LABELS[name] },
    });
    roleIds[name] = role.id;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const keys = expandGrants(ROLE_MATRIX[name]);
    await prisma.rolePermission.createMany({
      data: [...keys]
        .filter((k) => permByKey.has(k))
        .map((k) => ({ roleId: role.id, permissionId: permByKey.get(k)! })),
      skipDuplicates: true,
    });
  }

  const organization = await prisma.organization.upsert({
    where: { slug: 'buildora-demo-developers' },
    create: { name: 'Buildora Demo Developers', slug: 'buildora-demo-developers', settings: { timezone: 'Asia/Kolkata', currency: 'INR', demo: true } },
    update: { name: 'Buildora Demo Developers' },
  });

  const organizationRoleIds: Partial<Record<RoleName, string>> = {};
  for (const name of Object.keys(ROLE_MATRIX) as RoleName[]) {
    const organizationRole = await prisma.organizationRole.upsert({
      where: { organizationId_key: { organizationId: organization.id, key: name } },
      create: {
        organizationId: organization.id,
        key: name,
        label: ROLE_LABELS[name],
        isSystem: true,
        description: `Buildora default ${ROLE_LABELS[name]} permissions`,
      },
      update: { label: ROLE_LABELS[name], isSystem: true },
    });
    organizationRoleIds[name] = organizationRole.id;
    await prisma.organizationRolePermission.deleteMany({ where: { roleId: organizationRole.id } });
    const keys = expandGrants(ROLE_MATRIX[name]);
    await prisma.organizationRolePermission.createMany({
      data: [...keys]
        .filter((k) => permByKey.has(k))
        .map((k) => ({
          roleId: organizationRole.id,
          permissionId: permByKey.get(k)!,
          scope: ROLE_SCOPES[name] ?? 'ORGANIZATION',
        })),
      skipDuplicates: true,
    });
  }

  // ── Users (created first; broker's partner link applied after the CP account) ──
  const pw = bcrypt.hashSync('Passw0rd!', 10);
  const BROKER_ID = '00000000-0000-0000-0000-00000000brk0';
  const users: { id: string; name: string; email: string; role: RoleName }[] = [
    { id: '00000000-0000-0000-0000-00000000adm0', name: 'System Admin', email: 'admin@buildora.demo', role: 'SUPER_ADMIN' },
    { id: '00000000-0000-0000-0000-00000000crm0', name: 'Priya CRM Admin', email: 'crmadmin@buildora.demo', role: 'CRM_ADMIN' },
    { id: '00000000-0000-0000-0000-00000000agt0', name: 'Rahul Agent', email: 'agent@buildora.demo', role: 'SALES_AGENT' },
    { id: '00000000-0000-0000-0000-00000000agt1', name: 'Sneha Agent', email: 'agent2@buildora.demo', role: 'SALES_AGENT' },
    { id: BROKER_ID, name: 'Vikram Broker', email: 'broker@buildora.demo', role: 'CHANNEL_PARTNER' },
    { id: '00000000-0000-0000-0000-000000000pm0', name: 'Anita PM', email: 'pm@buildora.demo', role: 'PROJECT_MANAGER' },
    { id: '00000000-0000-0000-0000-000000000fin', name: 'Deepak Finance', email: 'finance@buildora.demo', role: 'FINANCE' },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      create: { id: u.id, name: u.name, email: u.email, passwordHash: pw, roleId: roleIds[u.role]! },
      update: { name: u.name, email: u.email, passwordHash: pw, roleId: roleIds[u.role]!, isActive: true },
    });
  }
  for (const u of users) {
    await prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: u.id } },
      create: {
        organizationId: organization.id,
        userId: u.id,
        roleId: roleIds[u.role]!,
        organizationRoleId: organizationRoleIds[u.role]!,
      },
      update: { roleId: roleIds[u.role]!, organizationRoleId: organizationRoleIds[u.role]!, status: 'ACTIVE' },
    });
    await prisma.user.update({ where: { id: u.id }, data: { defaultOrganizationId: organization.id } });
  }
  const adminId = users[0].id;
  const agentId = users[2].id;

  // ── Channel partner account, then link the broker user to it ──
  const cpAccount = await prisma.account.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000cp' },
    create: {
      id: '00000000-0000-0000-0000-0000000000cp',
      name: 'Prime Realty Brokers',
      type: 'CHANNEL_PARTNER',
      empanelmentStatus: 'APPROVED',
      empanelmentDate: new Date(),
      commissionPercent: new Prisma.Decimal(1.5),
      kycStatus: 'VERIFIED',
      ownerId: adminId,
    },
    update: {},
  });
  await prisma.user.update({ where: { id: BROKER_ID }, data: { partnerAccountId: cpAccount.id } });

  // ── System config ──
  for (const [key, value] of Object.entries({
    holdHours: 48,
    gstRates: { underConstruction: 5 },
    discountThresholds: { SALES_AGENT: 1, PROJECT_MANAGER: 3, FINANCE: 5 },
    targets: { monthlyCollectionPaise: R(50000000).toString(), monthlyRevenuePaise: R(200000000).toString() },
    branding: { companyName: 'Buildora Demo Developers' },
  })) {
    await prisma.systemConfig.upsert({
      where: { organizationId_key: { organizationId: organization.id, key } },
      create: { organizationId: organization.id, key, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
  }

  // ── Payment plan ──
  const existingPlan = await prisma.paymentPlan.findFirst({ where: { name: 'Construction Linked Plan' } });
  if (!existingPlan) {
    await prisma.paymentPlan.create({
      data: {
        name: 'Construction Linked Plan',
        kind: 'CONSTRUCTION_LINKED',
        description: 'Standard CLP for residential towers',
        milestones: {
          create: [
            { label: 'On Booking', percent: new Prisma.Decimal(10), sortOrder: 0 },
            { label: 'On Foundation', percent: new Prisma.Decimal(20), sortOrder: 1 },
            { label: 'On 5th Slab', percent: new Prisma.Decimal(30), sortOrder: 2 },
            { label: 'On Roof Slab', percent: new Prisma.Decimal(25), sortOrder: 3 },
            { label: 'On Possession', percent: new Prisma.Decimal(15), sortOrder: 4 },
          ],
        },
      },
    });
  }

  // ── Notification templates ──
  for (const t of [
    { key: 'lead.assigned', channel: 'EMAIL', subject: 'New lead assigned', body: 'Hi {{agent}}, a new lead {{lead}} has been assigned to you.' },
    { key: 'visit.reminder', channel: 'SMS', subject: null, body: 'Reminder: site visit at {{project}} on {{time}}.' },
    { key: 'booking.confirmed', channel: 'EMAIL', subject: 'Booking confirmed', body: 'Your booking {{bookingNumber}} is confirmed.' },
  ]) {
    await prisma.notificationTemplate.upsert({
      where: { organizationId_key: { organizationId: organization.id, key: t.key } },
      create: { ...t, organizationId: organization.id },
      update: { body: t.body, subject: t.subject ?? undefined },
    });
  }

  // ── Project + tower + units ──
  let project = await prisma.project.findFirst({ where: { name: 'Skyline Heights' } });
  if (!project) {
    project = await prisma.project.create({
      data: {
        name: 'Skyline Heights',
        type: 'RESIDENTIAL',
        location: 'Whitefield, Bengaluru',
        reraNumber: 'PRM/KA/RERA/1251/446/PR/2024/001',
        launchDate: new Date('2024-01-15'),
        possessionDate: new Date('2027-06-30'),
        amenities: ['Clubhouse', 'Swimming Pool', 'Gymnasium', 'Landscaped Garden', 'Kids Play Area'],
      },
    });
    const tower = await prisma.tower.create({
      data: { projectId: project.id, name: 'Tower A', floors: 10, unitsPerFloor: 4 },
    });
    const types = ['TWO_BHK', 'THREE_BHK', 'TWO_BHK', 'THREE_BHK'] as const;
    const units: Prisma.InventoryUnitCreateManyInput[] = [];
    for (let floor = 1; floor <= 10; floor++) {
      for (let i = 0; i < 4; i++) {
        const t = types[i];
        const area = t === 'TWO_BHK' ? 1100 : 1450;
        units.push({
          projectId: project.id,
          towerId: tower.id,
          unitNumber: `A-${floor}0${i + 1}`,
          floor,
          type: t,
          superBuiltUpArea: new Prisma.Decimal(area),
          carpetArea: new Prisma.Decimal(area * 0.7),
          facing: ['East', 'West', 'North', 'South'][i],
          basePricePerSqftPaise: R(7500),
          plcChargesPaise: R(150000),
          floorRiseChargesPaise: R(floor * 25000),
          carParkingChargesPaise: R(350000),
          status: floor <= 2 ? 'BOOKED' : 'AVAILABLE',
        });
      }
    }
    await prisma.inventoryUnit.createMany({ data: units });
    await prisma.project.update({ where: { id: project.id }, data: { totalUnits: units.length } });
  }

  // ── Campaign ──
  let campaign = await prisma.campaign.findFirst({ where: { name: 'Q3 Digital Launch' } });
  if (!campaign) {
    campaign = await prisma.campaign.create({
      data: {
        name: 'Q3 Digital Launch',
        type: 'DIGITAL',
        segment: 'RESIDENTIAL',
        status: 'ACTIVE',
        startDate: new Date('2025-07-01'),
        endDate: new Date('2025-09-30'),
        budgetPaise: R(1500000),
        actualSpendPaise: R(620000),
        projectId: project.id,
        ownerId: adminId,
        sources: {
          create: [
            { channel: 'GOOGLE_ADS', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'skyline_q3' },
            { channel: 'FACEBOOK', utmSource: 'facebook', utmMedium: 'social', utmCampaign: 'skyline_q3' },
          ],
        },
      },
    });
  }

  // ── Sample leads ──
  const leadCount = await prisma.lead.count();
  if (leadCount === 0) {
    const stages = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'NEGOTIATION'] as const;
    for (let i = 0; i < 12; i++) {
      await prisma.lead.create({
        data: {
          name: `Prospect ${i + 1}`,
          mobile: `90000000${String(10 + i)}`,
          email: `prospect${i + 1}@example.com`,
          stage: stages[i % stages.length],
          score: 30 + ((i * 7) % 60),
          interestType: 'RESIDENTIAL',
          bhk: i % 2 === 0 ? '2BHK' : '3BHK',
          budgetMinPaise: R(8000000),
          budgetMaxPaise: R(12000000),
          preferredLocation: 'Whitefield',
          campaignId: campaign.id,
          sourceChannel: i % 2 === 0 ? 'GOOGLE_ADS' : 'FACEBOOK',
          ownerId: agentId,
        },
      });
    }
  }

  // ── Lead routing rules (demo) ──
  // Ordered, first-match-wins. Showcases the three routing dimensions:
  // by project, by geography, and by source channel.
  const agent2Id = users[3].id; // Sneha Agent
  const routingRules: {
    id: string;
    name: string;
    description: string;
    priority: number;
    projectId?: string;
    sourceChannel?: 'BROKER';
    locations?: string[];
    strategy: 'SPECIFIC_USER' | 'ROUND_ROBIN';
    targetUserId?: string;
    memberIds?: string[];
  }[] = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Skyline Heights → Rahul',
      description: 'Leads interested in Skyline Heights go to the project specialist.',
      priority: 0,
      projectId: project.id,
      strategy: 'SPECIFIC_USER',
      targetUserId: agentId,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Whitefield geography → sales pool',
      description: 'Whitefield/East Bengaluru leads balance across the sales team.',
      priority: 1,
      locations: ['Whitefield', 'Bengaluru'],
      strategy: 'ROUND_ROBIN',
      memberIds: [agentId, agent2Id],
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Broker leads → Sneha',
      description: 'Channel-partner submissions are handled by the broker desk.',
      priority: 2,
      sourceChannel: 'BROKER',
      strategy: 'SPECIFIC_USER',
      targetUserId: agent2Id,
    },
  ];
  for (const r of routingRules) {
    await prisma.leadRoutingRule.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        description: r.description,
        priority: r.priority,
        projectId: r.projectId,
        sourceChannel: r.sourceChannel,
        locations: r.locations ?? [],
        strategy: r.strategy,
        targetUserId: r.targetUserId,
        memberIds: r.memberIds ?? [],
        createdById: adminId,
      },
      update: {},
    });
  }

  // Legacy sample rows are backfilled into the demo tenant. In application
  // requests these IDs are derived by the Prisma tenant extension, never from
  // a browser-supplied field.
  await Promise.all([
    prisma.project.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.inventoryUnit.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.campaign.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.lead.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.account.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.opportunity.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.siteVisit.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.quotation.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.booking.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.demandSchedule.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.receipt.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.document.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.contact.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.leadActivity.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.opportunityActivity.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.visitFeedback.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.tower.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.priceRevision.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.quotationLineItem.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.bookingApproval.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.paymentPlan.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.paymentPlanMilestone.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.receiptAllocation.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.savedReport.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.dashboardWidget.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
    prisma.leadRoutingRule.updateMany({ where: { organizationId: null }, data: { organizationId: organization.id } }),
  ]);

  console.log('✅ Seed complete.');
  console.log('   Demo credentials are documented for local development only — see README.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
