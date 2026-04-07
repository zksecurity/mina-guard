import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  log,
  loadState,
  setupTestPage,
  activateTestKey,
  switchAccount,
  navigateTo,
  waitForBanner,
  waitForIndexer,
  getContract,
  getOwners,
  getProposals,
  getProposal,
  getApprovals,
  fundContract,
  dumpState,
  type TestAccount,
} from './helpers';
import { getNetworkConfig } from './network-config';

const netConfig = getNetworkConfig();
const SHORT_WAIT = netConfig.mode === 'devnet' ? 10_000 : 3_000;

let accounts: TestAccount[];
let contractAddress = '';
let proposalHash = '';

let page: Page;
let context: BrowserContext;
let currentAccount: TestAccount | null = null;

test.beforeAll(async ({ browser }) => {
  const state = loadState();
  accounts = state.accounts;

  context = await browser.newContext({ baseURL: netConfig.frontendUrl });
  page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('MultisigWorker') || text.includes('failed') || text.includes('Error')) {
      log(`[browser] ${text}`);
    }
  });
});

test.afterAll(async () => {
  await context?.close();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed') {
    log(`TEST FAILED: ${testInfo.title}`);
    log(`Error: ${testInfo.error?.message}`);
    if (testInfo.error?.stack) log(`Stack:\n${testInfo.error.stack}`);
    await dumpState(contractAddress);
  }
});

async function gotoWithWallet(path: string, account: TestAccount): Promise<void> {
  if (!currentAccount) {
    await setupTestPage(page, account);
    await page.goto(path, { waitUntil: 'networkidle' });
    await activateTestKey(page, account);
    currentAccount = account;
    return;
  }

  if (currentAccount.publicKey !== account.publicKey) {
    await switchAccount(page, account);
    currentAccount = account;
  }

  const closeBtn = page.locator('button:has-text("×")');
  if (await closeBtn.first().isVisible().catch(() => false)) {
    await closeBtn.first().click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await navigateTo(page, path);

  if (contractAddress && netConfig.mode === 'devnet') {
    const selector = page.locator('select');
    if (await selector.isVisible().catch(() => false)) {
      const currentValue = await selector.inputValue();
      if (currentValue !== contractAddress) {
        log(`Switching contract selector to ${contractAddress.slice(0, 12)}...`);
        await selector.selectOption(contractAddress);
        await page.waitForTimeout(2_000);
      }
    }
  }
}

test('batch transfer happy path', async () => {
  log('=== Deploy + setup MinaGuard contract ===');
  await gotoWithWallet('/deploy', accounts[0]);

  await page.waitForFunction(
    (addr: string) => document.body.textContent?.includes(addr.slice(0, 6)),
    accounts[0].publicKey,
    { timeout: 30_000 }
  );

  await page.waitForFunction(
    () => !document.body.textContent?.includes('Generating keypair'),
    { timeout: 60_000 }
  );

  const addressEl = page.locator('p.break-all.font-mono');
  await addressEl.waitFor({ state: 'visible', timeout: 10_000 });
  contractAddress = (await addressEl.textContent())?.trim() ?? '';
  expect(contractAddress).toMatch(/^B62/);

  const owner1Input = page.locator('input[placeholder*="Owner"]').first();
  await owner1Input.waitFor({ state: 'visible', timeout: 5_000 });
  await owner1Input.fill(accounts[0].publicKey);

  await page.getByRole('button', { name: /add owner/i }).click();

  const owner2Input = page.locator('input[placeholder*="Owner"]').nth(1);
  await owner2Input.waitFor({ state: 'visible', timeout: 5_000 });
  await owner2Input.fill(accounts[1].publicKey);

  const thresholdInput = page.locator('input[type="number"]').first();
  await thresholdInput.fill('2');

  await page.getByRole('button', { name: /deploy minaguard/i }).click();
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer discovers deployed contract with setup', async () => {
    const contract = await getContract(contractAddress);
    return contract !== null && contract.threshold === 2 && contract.numOwners === 2;
  });

  const contract = await getContract(contractAddress);
  expect(contract).not.toBeNull();
  expect(contract?.threshold).toBe(2);

  const owners = await getOwners(contractAddress);
  expect(owners.filter((owner: any) => owner.active)).toHaveLength(2);

  await fundContract(contractAddress, accounts[0], 10);

  log('=== Create offchain transfer proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  await page.getByRole('link', { name: 'Send MINA', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Send MINA', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  const recipientInput = page.locator('input[placeholder*="B62"]').first();
  await recipientInput.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientInput.fill(accounts[2].publicKey);

  const amountInput = page.locator('input[placeholder*="0"]').first();
  await amountInput.fill('1');

  await page.getByRole('button', { name: /submit proposal/i }).click();
  await waitForBanner(page, 'success');

  await waitForIndexer('offchain transfer proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((proposal: any) => proposal.txType === 'transfer');
  });

  const pendingProposals = await getProposals(contractAddress, 'pending');
  const transferProposal = pendingProposals.find((proposal: any) => proposal.txType === 'transfer');
  expect(transferProposal).toBeDefined();
  expect(transferProposal.approvalCount).toBe(1);
  expect(transferProposal.receivers).toEqual([
    { index: 0, address: accounts[2].publicKey, amount: '1000000000' },
  ]);
  proposalHash = transferProposal.proposalHash;

  log('=== Approve transfer proposal ===');
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer('transfer approval count reaches threshold', async () => {
    const proposal = await getProposal(contractAddress, proposalHash);
    return proposal !== null && proposal.approvalCount >= 2;
  });

  const approvals = await getApprovals(contractAddress, proposalHash);
  expect(approvals).toHaveLength(2);

  log('=== Execute batch transfer ===');
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer marks transfer as executed', async () => {
    const proposal = await getProposal(contractAddress, proposalHash);
    return proposal !== null && proposal.status === 'executed';
  });

  const executedProposal = await getProposal(contractAddress, proposalHash);
  expect(executedProposal).not.toBeNull();
  expect(executedProposal?.status).toBe('executed');
  expect(executedProposal?.origin).toBe('offchain');
  expect(executedProposal?.executedAtBlock).not.toBeNull();
  expect(executedProposal?.recipientCount).toBe(1);
  expect(executedProposal?.totalAmount).toBe('1000000000');
});
