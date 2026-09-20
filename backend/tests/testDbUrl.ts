// Single source of truth for the integration-test database URL, shared by the
// Vitest config (worker env) and globalSetup (provisioning). In CI set
// TEST_DATABASE_URL to point at a real Postgres; otherwise embedded Postgres
// is booted on port 5441.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5441/crm_test';
