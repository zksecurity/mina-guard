import { test, expect } from '@playwright/test';
import { connectWallet, navigateTo, openVault } from './ui-helpers';
import { TREASURY } from './fixtures';

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

test('proposal creation warns on each visit, including when the banner is dismissed', async ({ page }) => {
  await connectWallet(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Dismiss beta notice' }).click();
  await openVault(page, TREASURY);
  await navigateTo(page, '/transactions/new?type=transfer');

  const dialog = page.getByRole('dialog', { name: 'Before you create a proposal' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('You could lose funds');
  await expect(dialog).toContainText('including on Mainnet');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Offline', exact: true }).click();
  await expect(page.getByText('Signer Address (Fee Payer)')).toBeVisible();

  await navigateTo(page, '/transactions');
  await navigateTo(page, '/transactions/new?type=transfer');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Beta product notice' })).toHaveCount(0);

  await navigateTo(page, `/accounts/new?parent=${TREASURY}`);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible();

  await navigateTo(page, `/accounts/${TREASURY}`);
  await page.evaluate(() => (window as any).__e2eNavigate('/transactions/new?type=createChild'));
  await expect(page).toHaveURL(new RegExp(`/accounts/new\\?parent=${TREASURY}`));
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).not.toBeVisible();
});
