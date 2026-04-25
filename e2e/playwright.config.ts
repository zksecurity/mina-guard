import os from 'os';
import { defineConfig } from '@playwright/test';
import { getNetworkConfig } from './network-config';

const config = getNetworkConfig();

// Give Chromium's V8 up to 75% of system RAM (capped at 32 GB, floor at 8 GB).
// On a beefy self-hosted runner this eliminates the need for page recycling;
// on a GitHub-hosted runner (~7 GB) it stays at the 8 GB floor.
export const V8_HEAP_MB = Math.max(
  8192,
  Math.min(Math.floor(os.totalmem() / 1024 / 1024 * 0.75), 32768)
);

export default defineConfig({
  testDir: '.',
  testMatch: '*.test.ts',
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
    viewport: { width: 1024, height: 768 },
    launchOptions: {
      args: [
        '--disable-gpu',
        '--disable-features=TranslateUI',
        '--disable-blink-features=AutomationControlled',
        `--js-flags=--max-old-space-size=${V8_HEAP_MB}`,
      ],
    },
  },
});
