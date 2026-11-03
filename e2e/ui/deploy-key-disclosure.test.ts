import { test, expect } from '@playwright/test';
import { connectWallet, navigateTo, openVault } from './ui-helpers';
import { PERSONAL, TREASURY } from './fixtures';
import { GUARD_PERMISSION_KINDS, GUARD_SET_VERIFICATION_KEY_TXN_VERSION } from 'contracts/guard-permission-policy';

test('deploy key guidance lives in Settings Security instead of the vault dashboard', async ({ page }) => {
  await connectWallet(page);
  await openVault(page, TREASURY);
  const warning = page.getByRole('region', { name: 'Deploy key and Mina upgrades' });
  await expect(warning).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Show deploy key warning' })).not.toBeVisible();
  await expect(page.getByRole('alert', { name: 'Vault needs attention' })).not.toBeVisible();
  await navigateTo(page, '/settings');
  await expect(page.getByRole('region', { name: 'Security', exact: true })).toContainText(TREASURY);
  await expect(warning).toBeVisible();
  await expect(warning.getByText(/MinaGuard now offers the creator an optional download/)).toBeVisible();
  await expect(warning.getByText(/funds could become stuck/)).toBeVisible();
  await warning.getByText('Why saving the key may not be enough').click();
  await expect(warning.getByText(/anyone can pay to send an update/i)).toBeVisible();
  await warning.getByRole('button', { name: 'Close deploy key warning' }).click();
  await expect(warning).not.toBeVisible();
  await page.getByRole('button', { name: 'Show deploy key warning' }).click();
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Close deploy key warning' }).click();
  await openVault(page, PERSONAL);
  await expect(warning).not.toBeVisible();
  await navigateTo(page, '/settings');
  await expect(page.getByRole('region', { name: 'Security', exact: true })).toContainText(PERSONAL);
  await expect(warning).toBeVisible();
});

test('an older vault transaction version links to Security without showing recovery controls on the dashboard', async ({ page }) => {
  await connectWallet(page);
  await page.route(`**/api/accounts/${TREASURY}/security`, (route) => route.fulfill({
    json: {
      accountFound: true,
      verificationKeyHash: 'canonical-vk',
      verificationKeyMatches: true,
      setVerificationKeyTxnVersion: String(BigInt(GUARD_SET_VERIFICATION_KEY_TXN_VERSION) - 1n),
      permissionKinds: GUARD_PERMISSION_KINDS,
      expectedPermissionKinds: GUARD_PERMISSION_KINDS,
      permissionMismatches: ['setVerificationKey'],
      safe: true,
    },
  }));
  await openVault(page, TREASURY);
  const banner = page.getByRole('alert', { name: 'Vault needs attention' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('region', { name: 'Deploy key and Mina upgrades' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Check on-chain version' })).not.toBeVisible();
  await banner.getByRole('link', { name: 'Settings → Security' }).click();
  await expect(page).toHaveURL(/\/settings#security$/);
  await expect(page.getByRole('region', { name: 'Security', exact: true })).toContainText(TREASURY);
  await expect(page.getByRole('region', { name: 'Deploy key and Mina upgrades' })).toBeVisible();
});

for (const kind of ['vault', 'subvault'] as const) {
  test(`${kind} creation explains deploy-key choices and requires acknowledgment`, async ({ page }) => {
    await connectWallet(page);
    await page.goto(kind === 'vault' ? '/accounts/new' : `/accounts/new?parent=${TREASURY}`);
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    const notice = page.getByRole('region', { name: 'Save the deploy key?' });
    await expect(notice).toBeVisible();
    await expect(notice.getByText('If you save it')).toBeVisible();
    await expect(notice.getByText("If you don't save it")).toBeVisible();
    await expect(notice.getByText(/anyone can submit the first Vault update/)).toBeVisible();
    await expect(notice.getByText(/funds could become stuck/)).toBeVisible();

    const details = notice.locator('details');
    await expect(details).not.toHaveAttribute('open');
    await notice.getByText('How recovery works after an upgrade').click();
    await expect(details).toHaveAttribute('open');
    await expect(notice.getByText(/Anyone can pay to submit a no-op update/)).toBeVisible();
    await expect(notice.getByText(/migration with the saved deploy key must land/)).toBeVisible();
    await expect(notice.getByText(/MinaGuard cannot recover this key/)).toBeVisible();
    const minaDocs = notice.getByRole('link', { name: 'Read Mina’s explanation of transaction versions' });
    await expect(minaDocs).toHaveAttribute('href', 'https://docs.minaprotocol.com/zkapps/tutorials/upgrading-a-zkapp#the-permission-that-decides');
    await expect(minaDocs).toHaveAttribute('target', '_blank');

    const acknowledge = page.getByRole('checkbox', { name: /I understand the risks of saving or not saving/ });
    await expect(page.getByRole('region', { name: 'Deploy key backup' }).getByText(/Store this file securely offline/)).toBeVisible();
    const submit = page.getByRole('button', { name: kind === 'vault' ? /deploy vault/i : /propose subvault/i });
    await expect(submit).toBeDisabled();
    await acknowledge.check();
    await expect(submit).toBeEnabled();

    const address = page.getByText('Contract Address', { exact: true }).locator('..').locator('p.font-mono');
    const oldAddress = (await address.innerText()).trim();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download deploy key for recovery' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`minaguard-deploy-key-${oldAddress}.txt`);
    await download.delete();

    await page.getByRole('button', { name: 'Regenerate' }).click();
    await expect(address).not.toHaveText(oldAddress);
    await expect(acknowledge).not.toBeChecked();
    await expect(submit).toBeDisabled();
  });
}
