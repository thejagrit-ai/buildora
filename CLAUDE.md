# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reality CRM — a custom (non-Salesforce) Real Estate CRM for mid-to-large developers, covering
**Campaign → Lead → Account → Opportunity → Site Visit → Quotation → Booking → Demand & Receipt**,
backed by a multi-tower inventory engine. Two deployables: an Express/Prisma API (`backend/`) and a
React/Vite SPA (`frontend/`), backed by PostgreSQL + Redis.

## Environment constraints on this machine (Windows)

- **No Docker and no local PostgreSQL/psql installed.** Don't suggest `docker compose up` for local
  dev/test on this box — it won't work. Tests use an **in-process embedded Postgres**
  (`embedded-postgres` package, binaries already present in `node_modules`).
- **C: drive has no free space; D: does.** npm cache is set to `D:\npm-cache`. Point any
  test/temp data dirs at `D:` (e.g. `TEST_PG_DATA_DIR=/d/npm-tmp/pgdata-test`,
  `D:/npm-tmp/devdb` for the dev DB).
- For local dev against a persistent DB (instead of the ephemeral test instance), use
  `npm run dev:db` in `backend/` — a self-healing embedded-Postgres launcher
  (`backend/scripts/dev-db.mjs`) matching `backend/.env` (user `crm` / pw `crm_secret` / db
  `reality_crm` / port 5432). Run `npx prisma db push` + `npm run seed` once after first boot.
- Embedded Postgres on this machine intermittently hits a Windows shared-memory reservation bug
  (antivirus loading a DLL over PG's shared-mem base address) — symptoms are `P1001 Can't reach
  database server` and very few `postgres.exe` processes running (healthy is ~6-10). The
  self-healing launcher works around it by restarting until connection probes succeed; the
  permanent fix is excluding `backend/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe`
  from antivirus scanning.
- Embedded Postgres must be initialized with UTF8/C locale (already configured in
  `dev-db.mjs` and `tests/globalSetup.ts`) — otherwise inserts containing non-ASCII text
  (₹, →, emoji) fail with Postgres error `22P05`. This is fixed at `initdb` time, so changing it
  requires wiping the data dir and re-running `prisma db push` + `npm run seed`.

## Commands

### Backend (`backend/`)

```bash
npm install
npm run dev          # ts-node-dev, http://localhost:4000 (Swagger at /api/docs)
npm run dev:db        # self-healing local Postgres (see above), only needed for manual/dev testing
npm run build          # prisma generate && tsc -p tsconfig.json -> dist/src
npm start              # node dist/src/index.js
npm run seed            # ts-node prisma/seed.ts (demo accounts, see README)
npm test                 # vitest run — boots embedded Postgres via globalSetup, no Docker needed
npm run test:watch
npm run migrate          # prisma migrate dev
npm run migrate:deploy
```

Run a single test file: `npx vitest run tests/flow.test.ts`. Tests are NOT parallel
(`fileParallelism: false` in `vitest.config.ts`) because they share one throwaway database.
To run against an existing database instead of the embedded one, set `TEST_DATABASE_URL`.

### Frontend (`frontend/`)

```bash
npm install
npm run dev       # vite --host, http://localhost:5173
npm run build      # tsc -b && vite build
npm run preview
```

## Architecture

### Backend layering (`backend/src/`)

```
config/      env (zod-validated) + permission catalogue / role matrix
lib/         prisma, redis, logger, money (paise), jwt, sequence, pdf,
             notify (email/sms/in-app), storage (S3 signed URLs), http, serialize
middleware/  auth (JWT) · rbac (authorize/requireRole) · scope (row-level)
             · audit (append-only) · validate (zod) · error · async
modules/     one router+service per domain — auth, campaigns, leads, accounts,
             opportunities, siteVisits, inventory, quotations, bookings,
             finance (demand+receipt), reports, dashboard, admin,
             notifications, search, customFields
app.ts       middleware stack + router mounting
index.ts     boot: prisma connect -> load permission cache -> listen
```

### Cross-cutting decisions (read before touching money, auth, or audit code)

- **Money is `BigInt` paise everywhere** — never floats. JSON can't carry `BigInt`, so
  `lib/serialize.ts` patches `res.json` to emit it as strings; the client parses losslessly
  (`frontend/src/lib/money.ts`). Requests accept rupees (`*Rupees` fields) and convert at the edge.
- **Dates** stored UTC; displayed IST (`Asia/Kolkata`), user-overridable.
- **RBAC** — `config/permissions.ts` defines dot-namespaced permissions (e.g. `leads.read`) and a
  role→permission matrix, materialised into `Role`/`Permission`/`RolePermission` by the seed. The
  matrix is cached in memory at boot (`reloadPermissions()`); every route is wrapped by
  `authenticate` + `authorize(permission)`. `SUPER_ADMIN` bypasses all checks.
- **Row-level scoping** — `middleware/scope.ts#scopeFilter(user, ownerField)` returns a Prisma
  `where` fragment, applied in services. Admins/PM/Finance see everything; agents see owned rows;
  channel partners are scoped to their `partnerAccountId`.
- **Audit** — every create/update/delete passes through `writeAudit()` into the append-only
  `AuditLog` table (never updated or deleted).
- **Document numbering** — `lib/sequence.ts#bumpCounter()` uses an atomic
  `INSERT ... ON CONFLICT ... RETURNING` against a counter row for sequential receipt/booking/
  quote/demand numbers.
- **PDFs** — `lib/pdf.ts` renders branded print-ready HTML (Allotment Letter, Quotation, Demand
  Letter, Receipt) rather than rasterising, to keep headless Chromium out of the API container.
- **RERA** fields live on Project and Booking. **Multi-project** from day one — every domain row
  carries `projectId` where relevant.

### Key business rules enforced in services (not just validation)

| Rule | Where |
| --- | --- |
| Lead convert -> Account + Contact + Opportunity (one transaction) | `leads.routes` |
| One open opportunity per unit (soft block, manager override) | `opportunities.routes` |
| Visit not schedulable in the past; feedback required before COMPLETED | `siteVisits.routes` |
| Hold only AVAILABLE units; time-limited; price revisions skip BOOKED/REGISTERED | `inventory.routes` |
| Accepted quotation locks pricing; versions retained | `quotations.routes` |
| Booking requires VERIFIED KYC + available unit; confirm locks opportunity WON | `bookings.routes` |
| Cancellation needs CRM Admin + Finance dual approval | `bookings.routes` |
| Receipt <= outstanding (advance override); auto-reconciled oldest-first | `finance.routes` |
| GST itemised per line/demand; overdue demands escalate | `quotations`/`finance` |

### Frontend (`frontend/src/`)

- React 18 + Vite + TypeScript, React Router, React Query (server state), Zustand (auth/session).
- `api/client.ts` — axios with a bearer request interceptor and a single-flight refresh-token
  interceptor that retries the original request on 401.
- `components/` — `Layout` (sidebar + global search + notification bell), `DataTable`, `ui.tsx`
  (`StatusBadge` with a shared status colour vocabulary, `Card`, `Modal`, `EmptyState`, `Field`,
  `Spinner`).
- `pages/` — one folder per module. Leads & Opportunities use drag-and-drop Kanban; Inventory uses
  a colour-coded floor x unit grid; Bookings uses a multi-step wizard.

### Testing

The integration suite (`backend/tests/flow.test.ts`, vitest + supertest) drives the real HTTP API
through the core lifecycle in one pass: login -> create inventory -> create lead -> convert ->
KYC gate -> booking — asserting cross-module rules (convert spawns Account+Opportunity, KYC blocks
booking, booking flips the unit to BOOKED, audit rows are written). `globalSetup.ts` boots/tears
down the embedded Postgres for the whole run.

See `docs/ARCHITECTURE.md` for more detail, including scale/performance notes (pagination
defaults, `Promise.all` fan-out for dashboard KPIs, ILIKE search with a migration path to
`pg_trgm`/Elasticsearch).
