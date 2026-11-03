import { test, expect, type Page } from '@playwright/test';
import { connectWallet, openVault, navigateTo } from './ui-helpers';
import { PROPOSALS, TREASURY, WALLET } from './fixtures';

const proposalHash = '91001';
const txHash = '5Jv3HXAGmockSubmissionTransactionhGKETjMA';

async function openSubmittedProposal(page: Page, status: 'pending' | 'included' | 'failed' | 'unknown') {
  await connectWallet(page);
  await page.addInitScript(({ contractAddress, proposalHash, txHash, signerPubkey }) => {
    localStorage.setItem('mina-guard-ui-pending-txs', JSON.stringify([{
      kind: 'create', contractAddress, proposalHash, txHash, signerPubkey,
      createdAt: new Date().toISOString(),
      summary: { txType: 'transfer', nonce: '6', configNonce: '1', expirySlot: '0', destination: 'local', childAccount: null, receivers: [] },
    }]));
  }, { contractAddress: TREASURY, proposalHash, txHash, signerPubkey: WALLET });
  await page.route('**/api/tx-status?*', (route) => route.fulfill({ json: { status } }));
  await openVault(page, TREASURY);
  await navigateTo(page, `/transactions/${proposalHash}`);
}

test('one submission card replaces duplicate pending notices and hashes', async ({ page }) => {
  await openSubmittedProposal(page, 'pending');
  const card = page.getByRole('status', { name: 'Transaction submission' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Waiting for network confirmation' })).toBeVisible();
  await expect(card.getByText('New submissions to this Vault are paused until its transaction history updates.')).toBeVisible();
  await expect(card.locator('li[aria-current="step"]')).toContainText('Network confirmation');
  await expect(card.getByText('5Jv3HXAG...hGKETjMA', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Indexer catching up', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Submitted — awaiting inclusion', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Pending', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: /approve proposal|execute proposal/i })).not.toBeVisible();
});

test('network inclusion advances the card without unlocking unindexed proposals', async ({ page }) => {
  await openSubmittedProposal(page, 'included');
  const card = page.getByRole('status', { name: 'Transaction submission' });
  await expect(card.getByRole('heading', { name: 'Confirmed. Updating your Vault…' })).toBeVisible();
  await expect(card.locator('li[aria-current="step"]')).toContainText('Vault updated');
  await expect(page.getByRole('button', { name: /approve proposal|execute proposal/i })).not.toBeVisible();

  // The network lookup is informational; only reconciliation removes the card.
  await page.evaluate(() => {
    localStorage.removeItem('mina-guard-ui-pending-txs');
    window.dispatchEvent(new Event('mina-guard-pending-txs-changed'));
  });
  await expect(card).not.toBeVisible();
});

test('unknown network status does not claim confirmation', async ({ page }) => {
  await openSubmittedProposal(page, 'unknown');
  const card = page.getByRole('status', { name: 'Transaction submission' });
  await expect(card.getByRole('heading', { name: 'Checking transaction confirmation' })).toBeVisible();
  await expect(card.getByText('Network confirmed', { exact: true })).not.toBeVisible();
  await expect(card.locator('li[aria-current="step"]')).toContainText('Network confirmation');
});

test('failed transactions show a failure rather than an indefinite wait', async ({ page }) => {
  await openSubmittedProposal(page, 'failed');
  const card = page.getByRole('alert', { name: 'Transaction submission' });
  await expect(card.getByRole('heading', { name: 'Transaction failed' })).toBeVisible();
  await expect(card.getByText('The network reported a failure. Waiting for the Vault status to refresh.')).toBeVisible();
  await expect(card.getByText('Network confirmed', { exact: true })).not.toBeVisible();
});

test('a different pending transaction does not hide the viewed proposal status', async ({ page }) => {
  await openSubmittedProposal(page, 'pending');
  await navigateTo(page, `/transactions/${PROPOSALS.expiredTransfer}`);
  await expect(page.getByText('expired', { exact: true })).toBeVisible();
  const card = page.getByRole('status', { name: 'Transaction submission' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Vault transaction', { exact: true })).toBeVisible();
});
