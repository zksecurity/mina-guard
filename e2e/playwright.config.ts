import { defineConfig } from '@playwright/test';
import { getNetworkConfig } from './network-config';

const config = getNetworkConfig();

export default defineConfig({
  testDir: '.',
  testMatch: '*.test.ts',
  timeout: config.testStepTimeoutMs,
  retries: 0,
  // Serial: tests are sequenced and share one browser context so the
  // contract-compile happens once for the whole run.
  workers: 1,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: config.frontendUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: config.mode === 'devnet' ? 60_000 : 30_000,
    // Smaller viewport = smaller renderer backing buffer.
    viewport: { width: 1024, height: 768 },
    launchOptions: {
      args: [
        '--disable-gpu',
        '--disable-features=TranslateUI',
        '--disable-blink-features=AutomationControlled',
      ],
    },
  },
});
