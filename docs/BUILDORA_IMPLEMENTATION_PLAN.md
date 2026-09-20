# BUILDORA implementation plan

## Audit summary — 20 September 2026

BUILDORA is a React 18/Vite SPA backed by an Express 4 and Prisma/PostgreSQL API. It has substantial, reusable real-estate workflow coverage: campaigns, lead routing and conversion, accounts/KYC, opportunities, site visits, inventory, quotations, bookings, demand schedules/receipts, reporting, notifications and audit records. The UI has shared primitives, React Query, route guards and a responsive baseline. Booking has a database unique constraint on `Booking.unitId` and uses a transaction, but the availability check currently occurs before that transaction.

### High-priority findings

1. **Tenant isolation is not implemented.** There is no Organization model or organization foreign key on domain data; most resource lookups are by `id` only. Existing `scopeFilter` is role/owner based and cannot prevent cross-developer access. This blocks a valid multi-tenant SaaS claim.
2. **RBAC is role-global, not tenant-aware.** Roles are globally named enum values and permissions are cached by role name. The user model supports one role only. New Buildora roles, resource scopes, per-organization memberships and permission overrides require a schema redesign.
3. **Several detail and mutation routes do not apply ownership scope.** For example, booking detail/status/document paths and inventory detail/hold paths can be reached once a caller has a broad module permission. Client-side menu filtering is not a security boundary.
4. **The client persists access and refresh bearer tokens in localStorage.** This increases token exposure if any XSS occurs. The current bearer-token architecture does not require CSRF protection, but a move to HttpOnly refresh cookies must include CSRF/origin protection.
5. **Authentication lacks account lockout, password-reset, email-verification and per-identity throttling.** The existing route-wide limiter is a useful baseline but is insufficient for repeated attempts against a single account.
6. **Unvalidated sort fields are passed into Prisma orderBy.** Sorting needs an allowlist per endpoint. Partner API-key comparison should use a timing-safe check and its tenant/partner identity must be derived from the credential, not request values.
7. **Inventory holds and booking eligibility have race windows.** Unit state validation must be inside a serializable transaction or conditional update. Booking’s unique constraint is a safety net but its resulting conflict should become a business-safe response.
8. **Sensitive identifiers are represented in general account/document models.** PAN/Aadhaar and finance/document access need explicit field minimization, encrypted storage where warranted, and permissions such as `finance.view_sensitive` / `documents.view_customer`.

### Existing modules and gaps

| Area | Existing foundation | Buildora work |
| --- | --- | --- |
| CRM/Sales | Leads, accounts, opportunities, visits, quotations, bookings | Add tenant/resource scopes, configurable stages, tasks/activities, saved views, duplicate workflow |
| Inventory | Projects, towers, units, holds, pricing, floor grid | Add phases/floors/amenities, tenant safety, atomic holds/bookings, richer unit detail |
| Finance | Plans, demands, receipts, allocations, ledger | Add scoped finance visibility, adjustments/refunds, approval policy and aging widgets |
| Marketing | Campaigns, sources and reporting | Add secure webhook ingestion and connector abstractions; no live external integrations without credentials |
| Portals | A server-to-server partner intake endpoint only | Build tenant-scoped customer, partner and lender membership/portal APIs and screens |
| Operations | Project/inventory data | Add milestones, contractors, cost tracking and service tickets |

## Delivery sequence

1. **Foundation (current increment):** remove upstream UI identity, set Buildora product metadata and visual tokens, remove exposed demo credentials, and write migration/security requirements.
2. **Tenant/RBAC migration:** introduce `Organization`, `Membership`, tenant-local `Role`, `PermissionGrant(scope)`, project/team assignment tables and `organizationId` on every tenant record. Backfill one organization from legacy data. Replace role-name bypasses with membership-derived authorization and tenant-scoped repositories.
3. **Security hardening:** HttpOnly refresh-session design or reduced-persistence bearer strategy, per-identity login throttling/lockouts, reset/verification tokens, explicit query-sort allowlists, safe upload service, audit actor/tenant enrichment, direct API isolation tests.
4. **Core workflow correctness:** transactional unit hold and booking services, KYC/approval policy, finance state machine, service-layer ownership checks and protected operational APIs.
5. **Product surfaces:** Buildora navigation, command center, reusable tables/drawers, executive dashboard, inventory workspace, CRM/sales/finance screens and responsive variants.
6. **Portals/integrations:** customer, channel-partner and lender experiences driven by membership grants; event/outbox interfaces for email/SMS/WhatsApp/webhooks.
7. **Quality gate:** API/RBAC/tenant/concurrency tests, visual QA at desktop/tablet/mobile, accessibility review and production deployment runbook.

## Design direction

Buildora uses a quiet graphite-and-limestone workspace with a single architectural copper accent. The persistent “build mark” is a measured three-block monogram: it references a site plan without becoming decorative. Fraunces is retained only for high-level editorial moments; Inter and IBM Plex Mono handle dense operational data. This avoids the generic dashboard look while preserving information density and contrast.
