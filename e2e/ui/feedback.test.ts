import { test, expect } from '@playwright/test';

test('wallet connection help is available before a wallet is installed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Install Auro Wallet' }).first()).toBeVisible();
  const help = page.getByRole('link', { name: 'How to connect' }).first();
  await expect(help).toHaveAttribute('href', '/guide#wallets');
  await page.goto('/accounts/new');
  await expect(page.getByRole('link', { name: 'How to connect' }).first()).toBeVisible();
});

test('the standalone guide explains signing, funding, and support', async ({ page }) => {
  await page.goto('/guide');
  await expect(page.locator('#how')).toContainText('Each stage is a separate on-chain transaction');
  await expect(page.locator('#owner-approval-changes')).toContainText('including payments and delegation');
  await expect(page.locator('#actions')).toContainText('up to 9 recipients per proposal');
  await expect(page.locator('#actions')).toContainText('approved and executed');
  await expect(page.locator('#subvaults')).toContainText('ordinary wallet transfer');
  await expect(page.locator('#subvaults')).toContainText('collect approvals, and execute');
  await expect(page.locator('#offline')).toContainText('recipient count, and the total');
  await expect(page.locator('#wallets')).toContainText('does not replace a wallet or signing key');
  await expect(page.locator('#payments')).toContainText('does not currently send incoming-payment email or push alerts');
  await expect(page.locator('#support a').first()).toHaveAttribute('href', 'https://github.com/zksecurity/mina-guard');
  await expect(page.locator('#support a').last()).toHaveAttribute('href', 'https://github.com/zksecurity/mina-guard/issues');
});
