import type { Request, Response, NextFunction } from 'express';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { reloadPermissions } from '../src/middleware/rbac';

// Vercel keeps warm function instances alive between requests. Reuse the Prisma
// client and permission cache instead of starting a long-running HTTP server.
const app = createApp();
let initialization: Promise<void> | undefined;

async function initialize() {
  await prisma.$connect();
  await reloadPermissions();
}

export default function handler(req: Request, res: Response, next: NextFunction) {
  initialization ??= initialize();
  initialization
    .then(() => app(req, res, next))
    .catch((error) => {
      initialization = undefined;
      next(error);
    });
}
