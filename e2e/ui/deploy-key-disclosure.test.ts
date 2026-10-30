import { test, expect } from '@playwright/test';
import { connectWallet } from './ui-helpers';
import { TREASURY } from './fixtures';

for (const kind of ['vault', 'subvault'] as const) {
  test(`${kind} creation explains deploy-key choices and requires acknowledgment`, async ({ page }) => {
    await connectWallet(page);
    // The SubVault wizard also shows the beta warning when that feature is enabled.
    await page.addLocatorHandler(
      page.getByRole('dialog', { name: 'Before you create a proposal' }),
      async (dialog) => { await dialog.getByRole('button', { name: 'Continue' }).click(); },
    );
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
