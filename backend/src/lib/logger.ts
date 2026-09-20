import pino, { Logger } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

// In dev we prefer pretty output, but pino-pretty runs in a transport worker
// whose module resolution can fail in some runtimes. Fall back to plain JSON
// logging rather than crashing the process on boot.
function createLogger(): Logger {
  const base = { redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'], censor: '[REDACTED]' } };
  if (!isDev) return pino({ ...base, level: 'info' });
  try {
    return pino({
      ...base,
      level: 'debug',
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  } catch {
    return pino({ ...base, level: 'debug' });
  }
}

export const logger = createLogger();
