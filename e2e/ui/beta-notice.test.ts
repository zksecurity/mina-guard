import { test, expect, type Page } from '@playwright/test';
import { MOCK_WALLET_SCRIPT } from '../wallet-mock';
import { navigateTo, openVault } from './ui-helpers';
import { TREASURY, WALLET } from './fixtures';

/** A wallet that reconnects on load, in a browser that never accepted the terms. */
async function newVisitorWithWallet(page: Page): Promise<void> {
  await page.addInitScript(MOCK_WALLET_SCRIPT);
  await page.addInitScript(`window.__testActiveAddress = ${JSON.stringify(WALLET)};`);
}

test('the beta banner can be dismissed for the current tab', async ({ page, context }) => {
  await page.goto('/');
  const notice = page.getByRole('complementary', { name: 'Beta product notice' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss beta notice' }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(notice).toHaveCount(0);
  await page.goto('/guide');
  await expect(notice).toHaveCount(0);

  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(otherTab.getByRole('complementary', { name: 'Beta product notice' })).toBeVisible();
  await otherTab.close();
});

test('a wallet connects only after the terms and beta risk are accepted, once per browser', async ({ page }) => {
  await newVisitorWithWallet(page);
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'Before you connect' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('You could lose funds');
  await expect(dialog).toContainText('including on Mainnet');
  await expect(dialog).toContainText('Mina network upgrades can also affect vaults');
  const accept = dialog.getByRole('button', { name: 'Continue' });
  await expect(accept).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /I understand the risks/ }).check();
  await accept.click();
  await expect(dialog).not.toBeVisible();

  // The full-width banner gives way to the header badge.
  await expect(page.getByRole('complementary', { name: 'Beta product notice' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'BETA' })).toBeVisible();

  await page.reload();
  await expect(page.getByText('Connect a wallet to see your Vaults.')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);

  // Accepted once: proposal pages no longer repeat the beta warning.
  await openVault(page, TREASURY);
  await navigateTo(page, '/transactions/new?type=transfer');
  await expect(page.getByRole('button', { name: 'Offline', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Before you create a proposal' })).toHaveCount(0);
});

test('declining disconnects, and the next connect asks again', async ({ page }) => {
  await newVisitorWithWallet(page);
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'Before you connect' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Connect a wallet to see your Vaults.').first()).toBeVisible();

  await page.getByRole('button', { name: 'Connect Auro Wallet' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: /I understand the risks/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Connect a wallet to see your Vaults.')).toHaveCount(0);
});

test('accepting in one tab clears the dialog in other open tabs', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await newVisitorWithWallet(page);
    await page.goto('/');
  }
  const dialogIn = (page: Page) => page.getByRole('dialog', { name: 'Before you connect' });
  await expect(dialogIn(second)).toBeVisible();

  await dialogIn(first).getByRole('checkbox', { name: /I understand the risks/ }).check();
  await dialogIn(first).getByRole('button', { name: 'Continue' }).click();
  await expect(dialogIn(second)).toHaveCount(0);
  await expect(second.getByRole('link', { name: 'BETA' })).toBeVisible();
});
