// Vitest globalSetup: provision a throwaway PostgreSQL for the integration
// tests and apply the Prisma schema. Runs once before the suite.
//
//  - If TEST_DATABASE_URL is set, that database is used directly (CI path).
//  - Otherwise an in-process embedded Postgres is started (no Docker needed).
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { TEST_DATABASE_URL } from './testDbUrl';

const PORT = 5441;
const DB = 'crm_test';
const DATA_DIR = process.env.TEST_PG_DATA_DIR ?? path.join(process.cwd(), '.pgtest-data');

let pg: EmbeddedPostgres | undefined;

export async function setup() {
  const useExternal = !!process.env.TEST_DATABASE_URL;

  if (!useExternal) {
    // Fresh data dir each run so the schema + data are pristine.
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* first run */ }
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      user: 'postgres',
      password: 'postgres',
      port: PORT,
      persistent: false,
      // Force UTF-8 so Unicode text (→, ₹, emoji, accents) stores correctly;
      // otherwise initdb on Windows defaults to WIN1252 and inserts can fail.
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(DB);
  }

  // Apply the schema to the (now empty) database.
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}

export async function teardown() {
  if (pg) {
    try { await pg.stop(); } catch { /* ignore */ }
  }
}
