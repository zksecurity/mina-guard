import { defineConfig } from '@playwright/test';

/**
 * UI test suite — real Next.js UI + real backend API over a deterministically
 * seeded database. No chain, no indexer, no proving: the backend boots with
 * INDEXER_DISABLED and a fixed latestSlot, and the DB is reset + seeded by
 * ui/seed.ts as part of the backend webServer command (keeping reset → seed
 * → serve strictly ordered).
 *
 * Requires a reachable Postgres; the database itself is disposable and
 * created on demand. Override the connection with E2E_UI_DATABASE_URL.
 */

export const UI_PORT = 3100;
export const BACKEND_PORT = 4010;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

// Default targets the repo's own e2e db container (preview-env compose maps
// it to host port 15432 to stay clear of any system postgres on 5432).
const DATABASE_URL =
  process.env.E2E_UI_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:15432/minaguard_uitest';

export default defineConfig({
  testDir: './ui',
  timeout: 120_000, // first `next dev` compile of a route can take ~1 min on CI
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'cd ../backend && bunx prisma db push --force-reset --skip-generate && bun ../e2e/ui/seed.ts && bun src/server.ts',
      url: `${BACKEND_URL}/health`,
      env: {
        DATABASE_URL,
        PORT: String(BACKEND_PORT),
        // Required by loadConfig but never contacted with the indexer disabled.
        MINA_ENDPOINT: 'http://127.0.0.1:1/graphql',
        ARCHIVE_ENDPOINT: 'http://127.0.0.1:1',
        INDEXER_DISABLED: 'true',
        INDEXER_FIXED_LATEST_SLOT: '1000', // see fixtures.FIXED_LATEST_SLOT
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `cd ../ui && bunx next dev -p ${UI_PORT}`,
      url: `http://localhost:${UI_PORT}`,
      env: {
        NEXT_PUBLIC_API_BASE_URL: BACKEND_URL,
        NEXT_PUBLIC_E2E_TEST: 'true',
        NEXT_PUBLIC_POLL_INTERVAL_MS: '2000',
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
