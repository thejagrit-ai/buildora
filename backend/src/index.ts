import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { connectRedis } from './lib/redis';
import { reloadPermissions } from './middleware/rbac';

async function main() {
  await prisma.$connect();
  await reloadPermissions(); // load role→permission cache
  await connectRedis();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 Buildora API listening on :${env.PORT} (docs at /api/docs)`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
