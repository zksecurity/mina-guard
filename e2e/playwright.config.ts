import { defineConfig } from '@playwright/test';
import { getNetworkConfig } from './network-config';

const config = getNetworkConfig();

export default defineConfig({
  testDir: '.',
  testMatch: '*.test.ts',
  testIgnore: ['onchain-flow.test.ts'],
  timeout: config.testStepTimeoutMs,
  retries: 0,
  workers: 1,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: config.frontendUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: config.mode === 'devnet' ? 60_000 : 30_000,
  },
});
