import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

// Redis is an optional cache/session store. If it's unreachable we stop
// retrying after a few attempts and run without it (no log spam).
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
});

let redisWarned = false;
redis.on('error', (err) => {
  if (!redisWarned) {
    logger.warn({ err: (err as Error).message }, 'redis unavailable — continuing without cache');
    redisWarned = true;
  }
});

export async function connectRedis() {
  try {
    await redis.connect();
    logger.info('redis connected');
  } catch {
    // Already surfaced once via the error handler; the app runs without cache.
  }
}
