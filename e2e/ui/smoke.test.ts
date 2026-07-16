import { test, expect } from '@playwright/test';
import { connectWallet, navigateTo, openVault, statusTab } from './ui-helpers';
import { BACKEND_URL } from '../playwright.ui.config';
import {
  TREASURY,
  OPS_CHILD,
  PERSONAL,
  PROPOSALS,
  TREASURY_COUNTS,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await connectWallet(page);
});

// ---------------------------------------------------------------------------
// API sanity: the backend serves derived statuses from the seeded DB. If this
// fails, fix the harness (seed/guard/fixed slot) before reading UI failures.
// ---------------------------------------------------------------------------

test('backend derives every proposal status from the seed', async ({ request }) => {
  for (const [status, count] of Object.entries({
    pending: TREASURY_COUNTS.pending,
    executed: TREASURY_COUNTS.executed,
    expired: TREASURY_COUNTS.expired,
    invalidated: TREASURY_COUNTS.invalidated,
  })) {
    const res = await request.get(
      `${BACKEND_URL}/api/contracts/${TREASURY}/proposals?status=${status}`
    );
    expect(res.ok()).toBe(true);
    const proposals = await res.json();
    expect(proposals, `status=${status}`).toHaveLength(count);
  }

  // Memo-match flags derived by the real serializer
  const executed = await (
    await request.get(
      `${BACKEND_URL}/api/contracts/${TREASURY}/proposals/${PROPOSALS.executedTransfer}`
    )
  ).json();
  expect(executed.memoExecutionMatch).toBe(true);
  const mismatch = await (
    await request.get(
      `${BACKEND_URL}/api/contracts/${TREASURY}/proposals/${PROPOSALS.executedMemoMismatch}`
    )
  ).json();
  expect(mismatch.memoExecutionMatch).toBe(false);
});

// ---------------------------------------------------------------------------
// UI smoke
// ---------------------------------------------------------------------------

test('vault list shows all seeded vaults', async ({ page }) => {
  await page.goto('/');
  for (const address of [TREASURY, OPS_CHILD, PERSONAL]) {
    await expect(
      page.getByText(address.slice(0, 10)).first(),
      `vault ${address.slice(0, 10)}...`
    ).toBeVisible({ timeout: 60_000 });
  }
});

test('vault dashboard renders with subvault card', async ({ page }) => {
  await openVault(page, TREASURY);
  await expect(page.locator('text=SubVaults (1)')).toBeVisible({ timeout: 10_000 });
});

test('transactions page shows tab counts for every derived status', async ({ page }) => {
  await openVault(page, TREASURY);
  await navigateTo(page, '/transactions');

  await expect(statusTab(page, /All/i)).toContainText(String(TREASURY_COUNTS.all), { timeout: 30_000 });
  await expect(statusTab(page, /Pending/i)).toContainText(String(TREASURY_COUNTS.pending));
  await expect(statusTab(page, /Executed/i)).toContainText(String(TREASURY_COUNTS.executed));
  await expect(statusTab(page, /Expired/i)).toContainText(String(TREASURY_COUNTS.expired));
  await expect(statusTab(page, /Invalidated/i)).toContainText(String(TREASURY_COUNTS.invalidated));
});
