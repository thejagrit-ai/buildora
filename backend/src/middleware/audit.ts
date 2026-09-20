// Append-only audit logging. Every create/update/delete in a service calls
// writeAudit(). Logs are never updated or deleted.
import { AuditAction, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { jsonSafe } from '../lib/serialize';

export async function writeAudit(opts: {
  userId?: string;
  action: AuditAction;
  module: string;
  entity: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string;
  tx?: Prisma.TransactionClient;
}) {
  const client = opts.tx ?? prisma;
  await client.auditLog.create({
    data: {
      userId: opts.userId,
      action: opts.action,
      module: opts.module,
      entity: opts.entity,
      entityId: opts.entityId,
      oldValue: opts.oldValue ? (jsonSafe(opts.oldValue) as Prisma.InputJsonValue) : undefined,
      newValue: opts.newValue ? (jsonSafe(opts.newValue) as Prisma.InputJsonValue) : undefined,
      ip: opts.ip,
    },
  });
}
