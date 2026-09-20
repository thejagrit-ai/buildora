# Buildora security review

## Executive summary

The application already uses Prisma, Zod validation, Helmet, JWT expiry, refresh-token hashing, rate limiting and append-only audit intent. It is not yet safe to operate as a multi-tenant SaaS: organization isolation is absent from the data model and several resource routes use unscoped identifiers. The findings below are based on code inspected on 20 September 2026.

## Critical

### SEC-001 — no tenant data boundary

- **Location:** [schema.prisma](backend/prisma/schema.prisma:57), [inventory.routes.ts](backend/src/modules/inventory.routes.ts:104), [bookings.routes.ts](backend/src/modules/bookings.routes.ts:123)
- **Evidence:** `User`, `Project`, `InventoryUnit`, `Booking` and the other domain models have no `organizationId`; project and booking creation/query code accepts or resolves records without a server-derived tenant filter.
- **Impact:** If multiple developer organizations share this deployment, a user with a matching permission can enumerate or act on other organizations’ resources. This is a cross-tenant IDOR risk.
- **Fix:** Add Organization/Membership/tenant-local Role/Grant models and an immutable `organizationId` to each tenant row. Resolve the active membership server-side from the authenticated session, inject its tenant filter in repositories, and test direct cross-tenant API calls.

## High

### SEC-002 — resource-level checks are incomplete

- **Location:** [bookings.routes.ts](backend/src/modules/bookings.routes.ts:190), [inventory.routes.ts](backend/src/modules/inventory.routes.ts:289), [scope.ts](backend/src/middleware/scope.ts:16)
- **Evidence:** Booking detail and inventory unit detail look up records by primary key; `scopeFilter` supplies owner/partner filters only where individual routes explicitly use it.
- **Impact:** A non-global role granted module access can potentially access resources outside its assigned/owned scope by supplying an ID.
- **Fix:** Centralize tenant + project/team/owned/assigned scope in service/repository queries. Never use unscoped `findUnique` for an externally supplied resource ID.

### SEC-003 — bearer refresh tokens were durably persisted in the browser

- **Location:** [auth.ts](frontend/src/store/auth.ts:38)
- **Evidence:** The original Zustand persistence used browser local storage for both access and refresh tokens.
- **Impact:** Any successful XSS could retain a reusable refresh token beyond the browser session.
- **Fix:** This increment changes persistence to `sessionStorage`. The production target should be a rotated HttpOnly refresh-session cookie with CSRF/origin protection, plus in-memory access tokens.

### SEC-004 — booking/hold concurrency window

- **Location:** [bookings.routes.ts](backend/src/modules/bookings.routes.ts:123), [inventory.routes.ts](backend/src/modules/inventory.routes.ts:348)
- **Evidence:** Unit availability is read before the booking transaction and before hold state is updated.
- **Impact:** Concurrent requests can both observe an available unit. The booking unique constraint reduces duplicate bookings, but hold behavior and business errors remain race-prone.
- **Fix:** Move validation into a serializable transaction or use a conditional `updateMany` on `{ id, status: AVAILABLE }`, checking the affected-row count. Translate uniqueness conflicts to a safe `409` response and add a concurrency test.

## Medium

### SEC-005 — authentication abuse controls are incomplete

- **Location:** [app.ts](backend/src/app.ts:39), [auth.routes.ts](backend/src/modules/auth.routes.ts:38)
- **Evidence:** The route group has a 50-request/15-minute limiter, but there is no per-email/IP login policy, failed-attempt state, temporary lockout, reset token flow or email verification.
- **Fix:** Add an account-security table/service, generic login errors, per-identity and per-IP limits, exponential lockouts, audit events, one-time hashed reset/verification tokens and a mail-provider abstraction.

### SEC-006 — sortable fields are not endpoint-allowlisted

- **Location:** [http.ts](backend/src/lib/http.ts:16)
- **Evidence:** `orderBy` constructs a Prisma field name directly from the `sort` query parameter.
- **Fix:** Each list endpoint should map user-facing sort keys to a fixed allowlist of Prisma fields; reject all other keys.

### SEC-007 — partner API identity is not tenant-bound

- **Location:** [partner.routes.ts](backend/src/modules/partner.routes.ts:19)
- **Evidence:** One shared API key gates all partner intake; it has no organization or partner binding.
- **Fix:** Replace it with tenant/partner-bound hashed credentials, constant-time comparison, rotation/revocation, scoped rate limits and audit metadata. Derive the target organization from the credential.

## Verification notes

- Frontend production build passed after this increment.
- Backend build could not reach TypeScript verification because Prisma’s Windows native engine was locked while `prisma generate` attempted an atomic rename. No code workaround was applied; close processes holding the engine and rerun `npm run build`.
