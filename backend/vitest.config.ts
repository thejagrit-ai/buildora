import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './tests/testDbUrl';

// The integration tests run against a throwaway PostgreSQL.
//  - In CI / locally with a DB: set TEST_DATABASE_URL and it's used as-is.
//  - Otherwise: globalSetup boots an in-process embedded Postgres on port 5441.
export default defineConfig({
  test: {
    globalSetup: './tests/globalSetup.ts',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_ACCESS_SECRET: 'test_access_secret_key_change_me',
      JWT_REFRESH_SECRET: 'test_refresh_secret_key_change_me',
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '7d',
      NODE_ENV: 'test',
    },
  },
});
