# Buildora API security audit

## Enforcement model

All `/api/*` business routes are mounted behind `authenticate` and `requireTenant` in `backend/src/app.ts`. The tenant middleware derives the organization from the signed access-token membership; request-body and query-string `organizationId` values are not used for scope. Tenant-owned Prisma models are protected by the request-scoped Prisma middleware in `backend/src/lib/prisma.ts`, which injects organization ownership on create/upsert and organization predicates on reads, updates, deletes, and bulk operations.

Authentication routes are intentionally outside tenant middleware. They validate the user, active organization membership, and active organization before issuing tokens. Public partner intake is server-to-server only and now requires both `PARTNER_API_KEY` and the server-configured `PARTNER_ORGANIZATION_ID`; it does not accept a tenant identifier from the caller.

## Route inventory

| Surface | Authentication | Tenant context | Authorization | Notes |
| --- | --- | --- | --- | --- |
| `/api/auth/*` | public or token for change-password | login/refresh derive membership; reset is user-scoped | credential/session checks | rate-limited; reset tokens are hashed, expiring, one-use; failed-login backoff is persisted |
| campaigns, leads, accounts, opportunities, site visits | required | required | centralized permission middleware + tenant query scope | ownership/team filters are applied by scope helpers where supported |
| inventory, quotations, bookings | required | required | module permissions and transactional checks | booking uses atomic availability update and tenant-scoped lookups |
| finance/demands/receipts/payment plans | required | required | finance permissions | sensitive data is not exposed to users lacking finance access |
| reports/dashboard/search/notifications | required | required | module permissions | tenant-scoped models and server-side filtering |
| admin/custom-fields/routing | required | required | admin/role/feature permissions | organization roles and composite config keys are tenant-local |
| `/api/partner/*` | API key | server-configured organization | API-key gate + tenant context | no browser-selected organization is accepted |

## Known follow-up verification

The route inventory is source-audited, but full HTTP regression execution remains dependent on a reachable isolated PostgreSQL test database. The current Windows environment has PostgreSQL listening on `5432` while the repository test/development URL points to `55432`; Prisma schema-engine operations therefore cannot connect. Before release, run the existing tenant-isolation, lifecycle, and routing suites against Docker PostgreSQL or a dedicated isolated instance and add direct finance/document/export/download cases.

## Security invariants

- Resource IDs are never sufficient to cross tenant boundaries; the tenant predicate is applied server-side.
- Bulk updates/deletes and exports must use the same scoped query as single-record operations.
- Organization-local role permissions are loaded from `Membership.organizationRole`, with legacy role permissions retained only as a migration fallback.
- Audit logs remain append-only from normal application routes.
- Reset and refresh tokens are stored only as hashes; raw reset tokens are never logged or returned.
