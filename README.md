# BUILDORA — Build. Sell. Scale.

A production-grade, multi-project Real Estate CRM for mid-to-large developers. Custom
React + Node.js application (no Salesforce dependency) covering the full lifecycle:
**Campaign → Lead → Account → Opportunity → Site Visit → Quotation → Booking → Demand & Receipt**,
backed by a multi-tower inventory engine.

## Tech Stack

| Layer            | Technology                                            |
| ---------------- | ----------------------------------------------------- |
| Frontend         | React 18, TypeScript, Vite, Tailwind CSS, React Query |
| State            | Zustand                                               |
| Backend          | Node.js 20, Express, TypeScript                       |
| Database         | PostgreSQL (primary), Redis (cache/sessions)          |
| ORM              | Prisma                                                |
| Auth             | JWT access + refresh tokens, RBAC middleware          |
| File storage     | S3-compatible (signed URLs)                           |
| Email / SMS      | SendGrid + Twilio (pluggable providers)               |
| Charts           | Recharts                                              |
| Search           | PostgreSQL full-text                                  |
| Deployment       | Docker + Docker Compose                               |
| API docs         | Swagger / OpenAPI 3.0 at `/api/docs`                  |

## Repository layout

```
.
├── backend/          Express + Prisma API
│   ├── prisma/       schema.prisma + seed
│   └── src/
│       ├── config/        env + constants
│       ├── lib/           prisma, redis, logger, money, pdf, mailer
│       ├── middleware/     auth, rbac, audit, error, validate, rate-limit
│       └── modules/        one folder per domain module (router + service)
├── frontend/         React + Vite SPA
│   └── src/
│       ├── api/        axios client + react-query hooks
│       ├── store/      zustand auth store
│       ├── components/  shared UI (layout, table, badges, forms)
│       └── pages/      one folder per module
├── docker-compose.yml
└── .env.example
```

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build
# backend  → http://localhost:4000  (docs at /api/docs)
# frontend → http://localhost:5173
```

## Quick start (local dev)

```bash
# 1. Infra
docker compose up -d postgres redis

# 2. Backend
cd backend
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev          # http://localhost:4000

# 3. Frontend
cd ../frontend
npm install
npm run dev          # http://localhost:5173
```

## Demo accounts (after seed)

| Role            | Email                       | Password    |
| --------------- | --------------------------- | ----------- |
| Super Admin     | admin@buildora.demo        | Passw0rd!   |
| CRM Admin       | crmadmin@buildora.demo     | Passw0rd!   |
| Sales Agent     | agent@buildora.demo        | Passw0rd!   |
| Channel Partner | broker@buildora.demo       | Passw0rd!   |
| Project Manager | pm@buildora.demo           | Passw0rd!   |
| Finance         | finance@buildora.demo      | Passw0rd!   |

## Tests

An end-to-end integration test exercises the core lifecycle through the real HTTP
API (supertest): **login → create inventory → create lead → convert → KYC gate →
booking**, asserting cross-module rules (convert spawns Account+Opportunity, KYC
blocks booking, booking flips the unit to BOOKED, audit rows are written).

```bash
cd backend
npm test
```

No Docker or running database is required: the suite boots an **in-process
embedded PostgreSQL** (real Postgres, not a mock) via `globalSetup`, applies the
Prisma schema, and tears it down afterward. To run against an existing database
instead, set `TEST_DATABASE_URL`. On Windows you can point the throwaway data dir
at a roomy drive with `TEST_PG_DATA_DIR`.

## Architectural conventions

- **Money** is stored as `BigInt` paise (INR subunit) everywhere; never floats. Helpers in
  `backend/src/lib/money.ts` and `frontend/src/lib/money.ts`.
- **Dates** stored UTC; displayed IST (`Asia/Kolkata`), user-overridable.
- **RBAC** — every route is wrapped by `authenticate` + `authorize(permission)`. Row-level
  scoping is applied in services via `scopeFilter(user)`.
- **Audit** — all create/update/delete pass through `writeAudit()`; logs are append-only.
- **RERA** fields present on Project and Booking.
- **Multi-project** from day one — every domain row carries `projectId` where relevant.

See module-by-module detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
