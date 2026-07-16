/**
 * Display/state tests ported from the chain e2e suite (former steps 10, 11,
 * 17, 20, 28, 44, 50, 51 — plus the expired-detail and memo-indicator checks
 * whose chain fixtures were cut earlier). Same assertions against the same
 * real UI, rendered from the seeded DB instead of a live chain.
 */
import { test, expect, type Page } from '@playwright/test';
import { connectWallet, navigateTo, openVault, statusTab } from './ui-helpers';
import {
  TREASURY,
  OPS_CHILD,
  PERSONAL,
  RECIPIENT,
  TREASURY_STATE,
  PROPOSALS,
  MEMOS,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await connectWallet(page);
});

async function openProposal(page: Page, hash: string): Promise<void> {
  await openVault(page, TREASURY);
  await navigateTo(page, `/transactions/${hash}`);
}

async function expectNoActionButtons(page: Page, names: RegExp[]): Promise<void> {
  for (const name of names) {
    await expect(page.getByRole('button', { name })).not.toBeVisible();
  }
}

// --- former step 10 ---------------------------------------------------------

test('settings page shows vault configuration', async ({ page }) => {
  await openVault(page, TREASURY);
  await navigateTo(page, '/settings');

  await expect(page.locator('text=Required Confirmations')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`text=Owners (${TREASURY_STATE.numOwners})`)).toBeVisible();
  await expect(page.locator('text=Config Nonce')).toBeVisible();
  await expect(page.locator('text=Owners Commitment')).toBeVisible();
});

// --- former step 11 (tab click actually filters the list) -------------------

test('transactions tab click filters the list to that status', async ({ page }) => {
  await openVault(page, TREASURY);
  await navigateTo(page, '/transactions');

  await statusTab(page, /Executed/i).click();
  // Executed proposals carry nonces #3 and #2; the pending ones (#6, #7) hide.
  await expect(page.getByText('#3', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('#2', { exact: true })).toBeVisible();
  await expect(page.getByText('#6', { exact: true })).not.toBeVisible();

  await statusTab(page, /Pending/i).click();
  await expect(page.getByText('#6', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('#3', { exact: true })).not.toBeVisible();
});

// --- former steps 17 + 20 ----------------------------------------------------

test('dashboard delegate card shows None without a delegate', async ({ page }) => {
  await openVault(page, TREASURY);
  await expect(page.locator('text=None')).toBeVisible({ timeout: 10_000 });
});

test('dashboard delegate card shows the delegate address', async ({ page }) => {
  await openVault(page, PERSONAL);
  await expect(page.locator(`text=${RECIPIENT.slice(0, 8)}`).first()).toBeVisible({ timeout: 10_000 });
});

// --- former step 28 ----------------------------------------------------------

test('subvault appears in tree and child detail links its parent', async ({ page }) => {
  await page.goto('/');
  const childRow = page.locator('a', {
    has: page.locator(`text=${OPS_CHILD.slice(0, 10)}`),
  });
  await expect(childRow.first()).toBeVisible({ timeout: 60_000 });

  await openVault(page, OPS_CHILD);
  await expect(page.locator('text=Parent Vault')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`text=${TREASURY.slice(0, 10)}`).first()).toBeVisible();
});

// --- former step 44 ----------------------------------------------------------

test('non-existent proposal hash shows not-found, not a crash', async ({ page }) => {
  await openProposal(page, '12345678901234567890');
  await expect(page.locator('text=Proposal not found')).toBeVisible({ timeout: 10_000 });
});

// --- former steps 50/51 + restored 52 ----------------------------------------

test('executed proposal has no action buttons and shows memo match', async ({ page }) => {
  await openProposal(page, PROPOSALS.executedTransfer);

  await expect(page.getByText('executed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [
    /approve proposal/i,
    /execute proposal/i,
    /delete proposal/i,
  ]);
  await expect(page.locator(`text=${MEMOS.executedTransfer}`)).toBeVisible();
  await expect(page.getByText('✓', { exact: true })).toBeVisible(); // memo-match indicator
});

test('executed proposal with stripped memo shows mismatch indicator', async ({ page }) => {
  await openProposal(page, PROPOSALS.executedMemoMismatch);
  await expect(page.getByText('executed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('✗', { exact: true })).toBeVisible(); // memo-mismatch indicator
});

test('invalidated proposal has no action buttons', async ({ page }) => {
  await openProposal(page, PROPOSALS.invalidatedTransfer);
  await expect(page.getByText('invalidated', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [/approve proposal/i, /execute proposal/i]);
});

test('expired proposal has no approve/execute buttons', async ({ page }) => {
  await openProposal(page, PROPOSALS.expiredTransfer);
  await expect(page.getByText('expired', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [/approve proposal/i, /execute proposal/i]);
});
