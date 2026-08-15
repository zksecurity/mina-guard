/**
 * Guide screenshot capture — a generator, not a test. Runs under the UI harness
 * (playwright.ui.config.ts: seeded DB, mocked wallet, no chain) and writes PNGs
 * into ui/public/guide/ for the /guide route.
 *
 * The seeded backend has no chain/indexer, which would otherwise render an
 * "Indexer stopped" footer and a "-" balance. Both fetches are stubbed in the
 * page via a window.fetch monkey-patch (capture-only) so the shots look
 * production-like. Every capture is best-effort with a short click timeout so
 * one bad selector never hangs or aborts the run.
 *
 * Regenerate:  cd e2e && bunx playwright test --config playwright.ui.config.ts screenshots
 */
import { test, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { connectWallet, openVault, navigateTo, openProposalForm } from './ui-helpers';
import { WALLET, OWNER_3, TREASURY, PROPOSALS } from './fixtures';

const OUT = '../ui/public/guide';
mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1280, height: 900 } });
const CLICK = { timeout: 8000 } as const;

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

/** Best-effort: log and continue so one failure never loses the rest of the run. */
async function safe(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`[shot] ${name} ok`); }
  catch (err) { console.error(`[shot] ${name} FAILED: ${(err as Error).message}`); }
}

/** Stub the two no-chain artifacts (indexer status + on-chain balance) in-page. */
async function stubApis(page: Page): Promise<void> {
  await page.addInitScript(`
    (() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
        const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.indexOf('/api/indexer/status') !== -1) {
          return json({ running: true, lastRunAt: '2026-07-01T12:00:00.000Z', lastSuccessfulRunAt: '2026-07-01T12:00:00.000Z', latestChainHeight: 1000, indexedHeight: 1000, latestSlot: 1000, lastError: null, discoveredContracts: 3, indexerMode: 'full' });
        }
        if (url.indexOf('/api/account/') !== -1 && url.indexOf('/balance') !== -1) {
          return json({ balance: '125000000000' });
        }
        return orig(input, init);
      };
    })();
  `);
}

const ACTIONS = [
  'transfer', 'addOwner', 'removeOwner', 'changeThreshold', 'setDelegate',
  'createChild', 'allocateChild', 'reclaimChild', 'destroyChild', 'enableChildMultiSig',
] as const;

test('capture guide screenshots', async ({ page }) => {
  test.setTimeout(900_000);
  await stubApis(page);

  // Create a Vault, step 1: the connect screen (before the mock wallet exists).
  await safe('step-create-connect', async () => {
    await page.goto('/');
    await page.waitForTimeout(700);
    await shot(page, 'step-create-connect');
  });

  await connectWallet(page, WALLET);

  // Core screens.
  await safe('dashboard', async () => { await page.goto('/'); await page.waitForTimeout(800); await shot(page, 'dashboard'); });
  await safe('vault-detail', async () => { await openVault(page, TREASURY); await shot(page, 'vault-detail'); });
  await safe('proposals-list', async () => { await navigateTo(page, '/transactions'); await shot(page, 'proposals-list'); });

  // Create a Vault, steps 2 (name/network) and 3 (owners + deploy).
  await safe('step-create-name', async () => { await page.goto('/accounts/new'); await page.waitForTimeout(800); await shot(page, 'step-create-name'); });
  await safe('step-create-owners', async () => {
    await page.getByRole('button', { name: /^next$/i }).click(CLICK);
    await page.waitForTimeout(600);
    await shot(page, 'step-create-owners');
  });

  // One screenshot per action (also serve the SubVault + propose steps).
  for (const type of ACTIONS) {
    await safe(`action-${type}`, async () => {
      await openProposalForm(page, TREASURY, type);
      await page.waitForTimeout(500);
      await shot(page, `action-${type}`);
    });
  }

  // Execute state: 9002 is 2/2 (threshold met) for WALLET.
  await safe('step-execute', async () => {
    await page.goto(`/transactions/${PROPOSALS.pendingAddOwner}`);
    await page.waitForTimeout(800);
    await shot(page, 'step-execute');
  });

  // Air-gapped: the Offline tab of a transfer proposal (signer + CLI + export).
  await safe('step-offline', async () => {
    await openProposalForm(page, TREASURY, 'transfer');
    await page.getByRole('button', { name: 'Offline', exact: true }).click(CLICK);
    await page.waitForTimeout(500);
    await shot(page, 'step-offline');
  });

  // Approve state: 9001 is 1/2; OWNER_3 has not approved it. Re-point the mock
  // wallet's active address (addInitScript accumulates, last write wins). Last,
  // so no switch-back is needed.
  await safe('step-approve', async () => {
    await page.addInitScript(`window.__testActiveAddress = ${JSON.stringify(OWNER_3)};`);
    await page.goto(`/transactions/${PROPOSALS.pendingTransfer}`);
    await page.waitForTimeout(800);
    await shot(page, 'step-approve');
  });
});
