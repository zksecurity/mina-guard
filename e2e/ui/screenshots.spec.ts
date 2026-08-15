/**
 * Guide screenshot capture — not a test, a generator. Runs under the UI harness
 * (playwright.ui.config.ts: seeded DB, mocked wallet, no chain) and writes PNGs
 * into ui/public/guide/ for the /guide route's figures.
 *
 * Regenerate:  cd e2e && bunx playwright test --config playwright.ui.config.ts screenshots
 */
import { test, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { connectWallet, openVault, navigateTo, openProposalForm } from './ui-helpers';
import { WALLET, TREASURY, PROPOSALS } from './fixtures';

const OUT = '../ui/public/guide';
mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1280, height: 900 } });

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500); // let fonts + any enter animation settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

// Every LOCAL/child action, keyed to the ActionCard `code` in the guide.
const ACTIONS = [
  'transfer', 'addOwner', 'removeOwner', 'changeThreshold', 'setDelegate',
  'createChild', 'allocateChild', 'reclaimChild', 'destroyChild', 'enableChildMultiSig',
] as const;

test('capture guide screenshots', async ({ page }) => {
  test.setTimeout(600_000); // one test walks ~15 routes through next-dev compiles
  await connectWallet(page, WALLET);

  // -- Core screens ---------------------------------------------------------
  await page.goto('/');
  await page.waitForTimeout(800);
  await shot(page, 'dashboard');

  await openVault(page, TREASURY);
  await shot(page, 'vault-detail');

  await navigateTo(page, '/transactions');
  await shot(page, 'proposals-list');

  await page.goto(`/transactions/${PROPOSALS.pendingTransfer}`);
  await page.waitForTimeout(800);
  await shot(page, 'proposal-detail');

  await page.goto('/accounts/new');
  await page.waitForTimeout(800);
  await shot(page, 'create-vault');

  // -- One screenshot per action (the New Proposal form) --------------------
  for (const type of ACTIONS) {
    await openProposalForm(page, TREASURY, type);
    await page.waitForTimeout(500);
    await shot(page, `action-${type}`);
  }
});
