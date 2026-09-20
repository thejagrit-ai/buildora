// JSON cannot represent BigInt. We serialise BigInt → string so the frontend
// receives lossless paise values. Install this once on the Express app via
// app.set('json replacer', ...) is not supported, so we patch res.json output
// through a helper used by the response wrapper.
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

// Express monkey-patch: make res.json BigInt-safe globally.
import type { Express } from 'express';
export function installBigIntJson(app: Express) {
  app.use((_req, res, next) => {
    const original = res.json.bind(res);
    res.json = (body: unknown) => original(jsonSafe(body));
    next();
  });
}
