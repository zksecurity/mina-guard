import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.test.ts',
  timeout: 15 * 60 * 1000, // 15 min per test step (proof generation is slow)
  retries: 0,
  workers: 1,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
  },
});
