// Persistent local PostgreSQL for development — no Docker, no system install.
// Uses the `embedded-postgres` binary (already in node_modules). Data persists
// across restarts so your seed data sticks around.
//
//   npm run dev:db        # starts Postgres, keeps running until Ctrl+C
//
// Defaults match backend/.env (user "crm", db "reality_crm", port 5432).
// Override the data dir with DEV_PG_DATA_DIR (use a path WITHOUT spaces).
//
// WINDOWS NOTE — "could not reserve shared memory region ... error code 487":
// On Windows, ASLR (often nudged by antivirus/security DLLs) can place a DLL
// over the address Postgres reserved for its shared-memory segment, after which
// EVERY connection fork dies and the server looks unreachable. We mitigate two
// ways: (1) shrink the shared-memory footprint so a collision is far less
// likely, and (2) self-heal — probe the server on boot and on an interval, and
// if it can't accept a connection, restart the postmaster so it re-rolls to a
// fresh (hopefully clean) base address.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DEV_PG_DATA_DIR ?? 'D:/npm-tmp/devdb';
const PORT = Number(process.env.DEV_PG_PORT ?? 5432);
const USER = 'crm';
const PASSWORD = 'crm_secret';
const DB = 'reality_crm';

const MAX_BOOT_TRIES = 15;    // restarts to escape a colliding ASLR layout
const PROBE_TIMEOUT_MS = 4000;
const HEALTH_EVERY_MS = 10000;

let recentShmError = false;   // set from the postgres log stream

function makePg() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    // Force UTF-8 (+ C locale). Without this, initdb on a Windows English system
    // picks WIN1252, which can't store '→', '₹', emoji or accented text and fails
    // inserts with Postgres error 22P05. Only applies on first init of a cluster.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Smaller shared-memory segment => much lower chance of an "error 487"
    // collision, and a smaller region to re-map in each connection child.
    postgresFlags: [
      '-c', 'shared_buffers=32MB',
      '-c', 'max_connections=50',
      '-c', 'dynamic_shared_memory_type=windows',
      '-c', 'huge_pages=off',
    ],
    onLog: (msg) => {
      if (typeof msg === 'string' && msg.includes('error code 487')) recentShmError = true;
      process.stdout.write(msg.endsWith('\n') ? msg : msg + '\n');
    },
    onError: (msg) => {
      const s = msg instanceof Error ? msg.message : String(msg);
      if (s.includes('error code 487')) recentShmError = true;
      process.stderr.write(s.endsWith('\n') ? s : s + '\n');
    },
  });
}

// Open a single real connection and run a trivial query. Returns true only if a
// connection child was actually forked and served — i.e. NOT in the 487 state.
async function probeOnce(pg) {
  const client = pg.getPgClient('postgres');
  let timer;
  try {
    await Promise.race([
      (async () => { await client.connect(); await client.query('select 1'); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS); }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try { await client.end(); } catch { /* ignore */ }
  }
}

// The 487 fork failure is INTERMITTENT — a single successful probe can be a
// lucky fork while most connections still fail. Require N consecutive successes
// so we only declare "healthy" when the instance is genuinely serving forks.
async function canConnect(pg, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    if (!(await probeOnce(pg))) return false;
  }
  return true;
}

// Start the cluster and keep restarting until it can actually accept a
// connection (escapes the Windows shared-memory collision).
async function startHealthy() {
  const needsInit = !existsSync(path.join(DATA_DIR, 'PG_VERSION'));
  for (let attempt = 1; attempt <= MAX_BOOT_TRIES; attempt++) {
    const pg = makePg();
    recentShmError = false;
    try {
      if (needsInit && attempt === 1) {
        console.log(`Initialising new Postgres cluster at ${DATA_DIR} ...`);
        await pg.initialise();
      }
      await pg.start();
      if (await canConnect(pg)) {
        if (needsInit && attempt === 1) {
          try { await pg.createDatabase(DB); console.log(`✅ Created database "${DB}"`); }
          catch (e) { console.log('createDatabase note:', e?.message ?? e); }
        }
        console.log(`✅ PostgreSQL running on 127.0.0.1:${PORT} (attempt ${attempt})`);
        return pg;
      }
      console.log(`⚠️  Postgres came up but won't accept connections (Windows shm/487). Restarting (attempt ${attempt}/${MAX_BOOT_TRIES}) ...`);
      try { await pg.stop(); } catch { /* ignore */ }
    } catch (e) {
      console.log(`⚠️  start attempt ${attempt} failed: ${e?.message ?? e}`);
      try { await pg.stop(); } catch { /* ignore */ }
    }
  }
  throw new Error(`Could not get Postgres to accept connections after ${MAX_BOOT_TRIES} attempts.`);
}

let current = await startHealthy();

console.log(`
DATABASE_URL = postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}
(already set in backend/.env)

First time only, in a SECOND terminal:
  cd "D:\\Data\\Projects\\Reality CRM\\backend"
  $env:TEMP="D:\\npm-tmp"
  npx prisma db push      # create tables
  npm run seed            # load demo data
  npm run dev             # API on http://localhost:4000

Leave THIS terminal running. It self-heals the Windows "error 487" state.
Press Ctrl+C to stop the database.
`);

// Runtime self-heal: if the server stops accepting connections (the 487 state
// can reappear later, e.g. after a reboot/AV update shifts DLL addresses),
// restart the postmaster so it re-rolls to a fresh base address.
let healing = false;
const monitor = setInterval(async () => {
  if (healing) return;
  const ok = await canConnect(current, 2);
  if (ok && !recentShmError) return;
  healing = true;
  console.log('\n⚠️  Database stopped accepting connections (Windows shm/487) — self-healing: restarting postmaster ...');
  try { await current.stop(); } catch { /* ignore */ }
  try {
    current = await startHealthy();
    console.log('✅ Self-heal complete — database healthy again.\n');
  } catch (e) {
    console.error('❌ Self-heal failed:', e?.message ?? e);
  } finally {
    healing = false;
  }
}, HEALTH_EVERY_MS);

const stop = async () => {
  clearInterval(monitor);
  console.log('\nStopping PostgreSQL ...');
  try { await current.stop(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
