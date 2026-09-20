# Buildora production migration workflow

The repository currently has a synchronized development schema but no checked-in Prisma migration history. Treat the current production database as an existing installation; do not run `migrate reset` or create a destructive migration against it.

For a new environment:

```powershell
cd backend
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/baseline.sql
```

Review the generated SQL, apply it to an empty database, then create a matching baseline migration directory and mark it applied with `npx prisma migrate resolve --applied <migration_name>`.

For the existing synchronized database, take a backup, compare the live schema to `prisma/schema.prisma`, and generate a reviewed forward migration using `prisma migrate diff` against the live database URL. Apply it first to an isolated clone, verify organization-role backfills and composite configuration keys, then deploy with:

```powershell
$env:DATABASE_URL = '<production-url>'
npx prisma migrate deploy
```

The organization-local role migration must backfill each active membership to the seeded organization role before making that relation mandatory. The `SystemConfig` and `NotificationTemplate` changes use organization/key composite uniqueness; existing global rows must be copied or assigned to the owning organization before enforcing non-null ownership.

Never use `prisma db push` for production deployments. It remains suitable only for disposable development/test databases.
