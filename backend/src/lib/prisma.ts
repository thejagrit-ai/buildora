import { PrismaClient } from '@prisma/client';
import { tenantContext } from './tenantContext';

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Any model in this set receives a tenant predicate and a server-derived
// organizationId on create. This makes accidental unscoped route queries fail
// closed once request execution enters requireTenant.
const TENANT_MODELS = new Set([
  'Campaign', 'Lead', 'Account', 'Opportunity', 'SiteVisit', 'Project',
  'InventoryUnit', 'Quotation', 'Booking', 'DemandSchedule', 'Receipt',
  'Document', 'Notification', 'AuditLog', 'Contact', 'LeadActivity',
  'OpportunityActivity', 'VisitFeedback', 'Tower', 'PriceRevision',
  'QuotationLineItem', 'BookingApproval', 'PaymentPlan',
  'PaymentPlanMilestone', 'ReceiptAllocation', 'SavedReport',
  'DashboardWidget', 'LeadRoutingRule', 'CampaignSource',
  'CampaignResponse', 'CoApplicant', 'SystemConfig',
  'NotificationTemplate', 'CustomFieldDefinition', 'CustomFieldValue',
]);

basePrisma.$use(async (params, next) => {
  const context = tenantContext.get();
  if (!context || !params.model || !TENANT_MODELS.has(params.model)) return next(params);
  const args = (params.args ?? {}) as {
    where?: Record<string, unknown>;
    data?: Record<string, unknown> | Record<string, unknown>[];
    create?: Record<string, unknown>;
  };
  if (params.action === 'create' || params.action === 'createMany') {
    args.data = Array.isArray(args.data)
      ? args.data.map((row) => ({ ...row, organizationId: context.organizationId }))
      : { ...args.data, organizationId: context.organizationId };
  } else if (params.action === 'upsert') {
    args.where = { ...args.where, organizationId: context.organizationId };
    args.create = { ...args.create, organizationId: context.organizationId };
  } else {
    args.where = { ...args.where, organizationId: context.organizationId };
  }
  params.args = args;
  return next(params);
});

export const prisma = basePrisma;
