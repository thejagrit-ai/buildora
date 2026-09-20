# BUILDORA — Architecture

## Overview

A custom (non-Salesforce) Real Estate CRM covering the full sales lifecycle:

```
Campaign → Lead → Account → Opportunity → Site Visit
                                       → Quotation → Booking → Demand & Receipt
                                                             ↑
                                                        Inventory Unit
```

Two deployables: an Express/Prisma API (`backend/`) and a React/Vite SPA
(`frontend/`), backed by PostgreSQL + Redis.

## Backend layering

```
src/
  config/      env (zod-validated) + permission catalogue / role matrix
  lib/         prisma, redis, logger, money (paise), jwt, sequence, pdf,
               notify (email/sms/in-app), storage (S3 signed URLs), http, serialize
  middleware/  auth (JWT) · rbac (authorize/requireRole) · scope (row-level)
               · audit (append-only) · validate (zod) · error · async
  modules/     one router per domain — auth, campaigns, leads, accounts,
               opportunities, siteVisits, inventory, quotations, bookings,
               finance (demand+receipt), reports, dashboard, admin,
               notifications, search
  app.ts       middleware stack + router mounting
  index.ts     boot: prisma connect → load permission cache → listen
```

### Cross-cutting decisions

- **Money** — every monetary column is `BigInt` paise. JSON cannot carry BigInt,
  so `lib/serialize.ts` patches `res.json` to emit BigInt as strings; the client
  parses them losslessly (`frontend/src/lib/money.ts`). Requests accept rupees
  (`*Rupees`) and convert at the edge.
- **RBAC** — `config/permissions.ts` defines dot-namespaced permissions
  (`leads.read`) and a role→permission matrix. The seed materialises these into
  `Role`/`Permission`/`RolePermission`. At boot the matrix is cached in memory
  (`reloadPermissions()`); `authorize('x')` checks the cache. `SUPER_ADMIN`
  bypasses all checks.
- **Row-level security** — `middleware/scope.ts#scopeFilter(user, ownerField)`
  returns a Prisma `where` fragment. Admins / PM / Finance get global view;
  agents see owned rows; channel partners are scoped to their `partnerAccountId`.
- **Audit** — `writeAudit()` records who/what/when/old/new on every mutation into
  the append-only `AuditLog` table (never updated or deleted).
- **Document numbering** — `lib/sequence.ts#bumpCounter()` uses an atomic
  `INSERT … ON CONFLICT … RETURNING` against a counter row, giving sequential,
  tamper-evident receipt / booking / quote / demand numbers.
- **PDFs** — `lib/pdf.ts` renders branded, print-ready HTML for Allotment Letter,
  Quotation, Demand Letter and Receipt. HTML-first keeps headless Chromium out of
  the API container; a worker can rasterise to PDF if needed.

## Key business rules (enforced in services)

| Rule | Where |
| --- | --- |
| Lead convert → Account + Contact + Opportunity (txn) | `leads.routes` |
| One open opportunity per unit (soft block, manager override) | `opportunities.routes` |
| Visit not schedulable in the past; feedback required before COMPLETED | `siteVisits.routes` |
| Hold only AVAILABLE units; time-limited; price revisions skip BOOKED/REGISTERED | `inventory.routes` |
| Accepted quotation locks pricing; versions retained | `quotations.routes` |
| Booking requires VERIFIED KYC + available unit; confirm locks opportunity WON | `bookings.routes` |
| Cancellation needs CRM Admin + Finance dual approval | `bookings.routes` |
| Receipt ≤ outstanding (advance override); auto-reconciled oldest-first | `finance.routes` |
| GST itemised per line/demand; overdue demands escalate | `quotations`/`finance` |

## Frontend

- React 18 + Vite + TypeScript, React Router, React Query (server state), Zustand
  (auth/session).
- `api/client.ts` — axios with a request interceptor (bearer) and a single-flight
  refresh-token interceptor that retries the original request on 401.
- `components/` — `Layout` (sidebar + global search + notification bell),
  `DataTable`, `ui.tsx` (StatusBadge with a shared status colour vocabulary,
  Card, Modal, EmptyState, Field, Spinner).
- `pages/` — one page per module. Leads & Opportunities use drag-and-drop Kanban;
  Inventory uses a colour-coded floor×unit grid; Bookings uses a multi-step wizard.

## Scale & performance notes

- List endpoints are paginated (50 default) with sort + filter.
- Dashboard KPIs fan out via `Promise.all` to stay under the 2s target.
- Search uses ILIKE today; swap to `pg_trgm` / full-text or Elasticsearch behind
  the same `/api/search` contract for 50k+ units / 5k+ leads.
- Large report exports should move to async generation + notification delivery
  (the report endpoints already return a table-shaped payload ready for that).

## Verification status

- Backend: `tsc` clean; production build emits to `dist/src`; app boots and mounts
  all routers (verified without a live DB).
- Frontend: `tsc` clean; `vite build` produces a production bundle.
- A live end-to-end run requires PostgreSQL + Redis (see README quick-start).
