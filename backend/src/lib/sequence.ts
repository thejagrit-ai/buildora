// Sequential, tamper-evident document numbering (receipts, bookings, quotes,
// demands). Uses a SystemConfig row as an atomic counter inside a transaction.
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { tenantContext } from './tenantContext';

const PAD = 6;

/**
 * Atomic counter via raw SQL upsert (works around Json increment limitation).
 * Returns the new value.
 */
export async function bumpCounter(
  tx: Prisma.TransactionClient,
  key: string,
): Promise<number> {
  const organizationId = tenantContext.get()?.organizationId;
  if (!organizationId) throw new Error('Tenant context is required for document numbering');
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "SystemConfig" ("id", "organizationId", "key", "value", "updatedAt")
    VALUES (${randomUUID()}, ${organizationId}, ${`seq:${key}`}, '1'::jsonb, now())
    ON CONFLICT ("organizationId", "key") DO UPDATE
      SET "value" = (("SystemConfig"."value")::int + 1)::text::jsonb,
          "updatedAt" = now()
    RETURNING ("value")::int AS value;
  `;
  return rows[0].value;
}

export function formatDocNumber(prefix: string, seq: number): string {
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${String(seq).padStart(PAD, '0')}`;
}
