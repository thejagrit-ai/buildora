// The full permission catalogue and the role → permission matrix.
// Permissions are dot-namespaced "<module>.<action>". The seed script writes
// these to the DB; the rbac middleware checks the authenticated user's role set.
import { RoleName } from '@prisma/client';

export interface PermissionDef {
  key: string;
  label: string;
  module: string;
}

const M = (module: string, actions: string[]): PermissionDef[] =>
  actions.map((a) => ({ key: `${module}.${a}`, label: `${module}:${a}`, module }));

export const PERMISSIONS: PermissionDef[] = [
  ...M('campaigns', ['read', 'create', 'update', 'archive', 'analytics']),
  ...M('leads', ['read', 'create', 'update', 'convert', 'import', 'assign', 'delete', 'routing']),
  ...M('accounts', ['read', 'create', 'update', 'kyc', 'documents', 'empanel']),
  ...M('opportunities', ['read', 'create', 'update', 'stage', 'forecast']),
  ...M('siteVisits', ['read', 'create', 'update', 'feedback', 'analytics']),
  ...M('inventory', ['read', 'create', 'update', 'hold', 'pricing', 'status']),
  ...M('quotations', ['read', 'create', 'update', 'send', 'approve', 'accept']),
  ...M('bookings', ['read', 'create', 'update', 'cancel', 'amend', 'commission']),
  ...M('finance', ['read', 'demand', 'receipt', 'approveCancel', 'ledger']),
  ...M('reports', ['read', 'build', 'export']),
  ...M('admin', ['users', 'roles', 'config', 'workflow', 'audit', 'templates']),
];

// Wildcards expand to "all actions for that module" at seed time.
type RoleGrants = Record<RoleName, string[]>;

export const ROLE_MATRIX: RoleGrants = {
  SUPER_ADMIN: ['*'], // every permission

  CRM_ADMIN: [
    'campaigns.*', 'leads.*', 'accounts.*', 'opportunities.*',
    'siteVisits.*', 'inventory.*', 'quotations.*', 'bookings.*',
    'finance.read', 'finance.ledger', 'finance.approveCancel',
    'reports.*', 'admin.config', 'admin.workflow', 'admin.audit',
    'admin.templates', 'admin.users', 'admin.roles',
  ],

  SALES_AGENT: [
    'campaigns.read',
    'leads.read', 'leads.create', 'leads.update', 'leads.convert',
    'accounts.read', 'accounts.create', 'accounts.update', 'accounts.documents',
    'opportunities.read', 'opportunities.create', 'opportunities.update', 'opportunities.stage',
    'siteVisits.read', 'siteVisits.create', 'siteVisits.update', 'siteVisits.feedback',
    'inventory.read',
    'quotations.read', 'quotations.create', 'quotations.update', 'quotations.send',
    'bookings.read', 'bookings.create',
    'reports.read',
  ],

  CHANNEL_PARTNER: [
    'leads.read',
    'accounts.read',
    'opportunities.read',
    'siteVisits.read',
    'inventory.read', // limited view enforced in service layer
    'bookings.read', 'bookings.create',
    'reports.read',
  ],

  PROJECT_MANAGER: [
    'inventory.*',
    'siteVisits.*',
    'leads.read',
    'opportunities.read',
    'bookings.read', // read-only
    'reports.read',
  ],

  FINANCE: [
    'finance.*',
    'bookings.read', 'bookings.cancel', 'bookings.commission',
    'quotations.read', 'quotations.approve',
    'accounts.read', 'accounts.kyc',
    'reports.read', 'reports.export',
  ],
};
