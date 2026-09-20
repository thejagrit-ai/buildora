# Buildora on Vercel + Aiven

Buildora can run with two Vercel projects backed by an Aiven PostgreSQL service:

```text
Vercel project: buildora-frontend  ->  frontend/
Vercel project: buildora-api       ->  backend/
Aiven PostgreSQL                   ->  DATABASE_URL
```

## API project

Set the Vercel project root directory to `backend`. The included `vercel.json`
routes requests to `api/index.ts`, which exports the Express app as a serverless
function. `src/index.ts` remains the local long-running development entry point.

Build command:

```bash
npm run build
```

The API project environment must include:

```env
NODE_ENV=production
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require&schema=public
JWT_ACCESS_SECRET=<random-32-byte-secret>
JWT_REFRESH_SECRET=<random-32-byte-secret>
CORS_ORIGINS=https://YOUR-FRONTEND.vercel.app
REDIS_URL=redis://localhost:6379
```

The Redis value is retained for compatibility; the serverless entry point does
not open a long-running Redis connection. Configure an external Redis service if
features that require Redis are enabled.

## Frontend project

Set the Vercel project root directory to `frontend`.

Build command:

```bash
npm run build
```

Output directory:

```text
dist
```

Set:

```env
VITE_API_BASE_URL=https://YOUR-API.vercel.app/api
```

The included frontend `vercel.json` rewrites client-side routes to
`index.html`, so `/login`, `/reports`, and other React routes work on refresh.

## Database

Use the SSL connection URI shown by Aiven. For an initial non-production
environment, synchronize and seed from the backend project:

```bash
npx prisma generate
npx prisma db push
npm run seed
```

This repository does not yet contain a Prisma migrations directory. Before
using production data, create and verify a baseline migration and use
`npx prisma migrate deploy` instead of relying on `db push`.

Never commit Aiven credentials, JWT secrets, SMTP credentials, or AI keys.
