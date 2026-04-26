import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  log,
  loadState,
  setupTestPage,
  activateTestKey,
  switchAccount,
  navigateTo,
  waitForBanner as _waitForBanner,
  waitForIndexer,
  getContracts,
  getContract,
  getOwners,
  getProposals,
  getProposal,
  getApprovals,
  checkTxStatus,
  fundContract,
  getIndexerStatus,
  dumpState,
  type TestAccount,
} from './helpers';
import { getNetworkConfig } from './network-config';

const netConfig = getNetworkConfig();
const SETTLE_WAIT = netConfig.settlementWaitMs;
const SHORT_WAIT = netConfig.mode === 'devnet' ? 10_000 : 3_000;

import { V8_HEAP_MB } from './playwright.config';

// Each tx accumulates ~40MB of WASM state. Recycle before hitting ~50% of heap.
// On machines with >=16GB heap (i.e. >=21GB RAM), recycling is unnecessary.
const RECYCLE_EVERY_N_TXS = V8_HEAP_MB >= 16384 ? 0 : 15;
let txCount = 0;

log(`V8 heap: ${V8_HEAP_MB}MB — page recycling ${RECYCLE_EVERY_N_TXS ? `every ${RECYCLE_EVERY_N_TXS} txs` : 'disabled'}`);


async function waitForBanner(...args: Parameters<typeof _waitForBanner>) {
  const result = await _waitForBanner(...args);
  if (args[1] !== 'error') txCount++;
  return result;
}

// ---------------------------------------------------------------------------
// Shared state across sequential tests
// ---------------------------------------------------------------------------

let accounts: TestAccount[];
let contractAddress: string;
let childAddress: string;
let proposalHashes: string[] = [];

// Shared page — avoids Web Worker restart (and contract recompilation) between tests
let sharedPage: Page;
let sharedContext: BrowserContext;
let currentAccount: TestAccount | null = null;

test.beforeAll(async ({ browser }) => {
  const state = loadState();
  accounts = state.accounts;
  log(`Loaded ${accounts.length} test accounts`);
  accounts.forEach((a, i) =>
    log(`  Account ${i + 1}: ${a.publicKey}`)
  );
  
  // Create a single page that will be reused for all tests
  sharedContext = await browser.newContext({ baseURL: netConfig.frontendUrl });
  sharedPage = await sharedContext.newPage();

  // Capture browser console for diagnostics. Wide filter so [startOperation]
  // and [MultisigWorker] breadcrumbs flow through — silent worker failures
  // are otherwise invisible from the Playwright side.
  sharedPage.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'debug') return;
    if (/\[Fast Refresh\]|webpack|hot-reloader-client/i.test(text)) return;
    log(`[browser ${type}] ${text}`);
  });
});

test.afterAll(async () => {
  await sharedContext?.close();
});

// All tests run in order in the same browser context
test.describe.configure({ mode: 'serial' });

/**
 * Navigate to a path with the mock wallet active for the given account.
 * The first call does a full page.goto (which starts contract compilation).
 * Subsequent calls use client-side navigation to preserve the Web Worker.
 */
async function gotoWithWallet(
  path: string,
  account: TestAccount
): Promise<void> {
  const page = sharedPage;

  if (!currentAccount) {
    // First navigation — full page load to bootstrap the app + worker
    await setupTestPage(page, account);
    await page.goto(path, { waitUntil: 'networkidle' });
    await activateTestKey(page, account);
    currentAccount = account;
  } else {
    // Client-side navigation — preserves worker (no recompilation)
    if (currentAccount.publicKey !== account.publicKey) {
      await switchAccount(page, account);
      currentAccount = account;
    }
    // Dismiss any stale operation banner before navigating
    const closeBtn = page.locator('button:has-text("×")');
    if (await closeBtn.first().isVisible().catch(() => false)) {
      await closeBtn.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
    await navigateTo(page, path);
  }

  // On devnet the indexer discovers old contracts from previous runs,
  // so the sidebar dropdown may default to the wrong one.
  if (contractAddress && netConfig.mode === 'devnet') {
    const selector = page.locator('select');
    if (await selector.isVisible().catch(() => false)) {
      const currentVal = await selector.inputValue();
      if (currentVal !== contractAddress) {
        log(`Switching contract selector to ${contractAddress.slice(0, 12)}...`);
        await selector.selectOption(contractAddress);
        await page.waitForTimeout(2_000);
      }
    }
  }
}

async function recyclePage(): Promise<void> {
  log('=== Recycling page to reclaim WASM memory ===');
  currentAccount = null;
  await sharedPage.reload({ waitUntil: 'networkidle' });
  await sharedPage.waitForTimeout(2_000);
  log('Page recycled');
}

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed') {
    log(`TEST FAILED: ${testInfo.title}`);
    log(`Error: ${testInfo.error?.message}`);
    if (testInfo.error?.stack) {
      log(`Stack:\n${testInfo.error.stack}`);
    }
    await dumpState(contractAddress);
  }

  if (RECYCLE_EVERY_N_TXS > 0 && txCount >= RECYCLE_EVERY_N_TXS) {
    log(`${txCount} txs since last recycle — recycling page`);
    txCount = 0;
    await recyclePage();
  }
});

// ---------------------------------------------------------------------------
// 1. Deploy MinaGuard contract
// ---------------------------------------------------------------------------

test('1. Deploy MinaGuard contract', async () => { const page = sharedPage;
  log('=== Step 1: Deploy MinaGuard contract ===');
  // New UI: "+ Create account" on `/` routes to the 2-step wizard at
  // `/accounts/new`. Step 1 is name + network (Testnet is the only
  // enabled option), step 2 is owners + threshold + keypair + deploy.
  await gotoWithWallet('/accounts/new', accounts[0]);

  // Wait for the wallet to connect — the header should show the address
  await page.waitForFunction(
    (addr: string) => document.body.textContent?.includes(addr.slice(0, 6)),
    accounts[0].publicKey,
    { timeout: 30_000 }
  );
  log('Wallet connected');

  // Step 1 → Step 2 (skip the optional name, default network=Testnet)
  log('Advancing wizard to step 2...');
  await page.getByRole('button', { name: /^next$/i }).click();

  // Wait for keypair generation (only starts once step 2 mounts)
  log('Waiting for keypair generation...');
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Generating keypair'),
    { timeout: 60_000 }
  );

  // Capture the generated contract address — find the <p> immediately after
  // the "Contract Address" label. Using getByText with exact match avoids
  // collisions with the Owner 1 input's `font-mono` class.
  const addressEl = page
    .getByText('Contract Address', { exact: true })
    .locator('xpath=following-sibling::p[1]');
  await addressEl.waitFor({ state: 'visible', timeout: 10_000 });
  contractAddress = (await addressEl.textContent())?.trim() ?? '';
  expect(contractAddress).toMatch(/^B62/);
  log(`Contract address: ${contractAddress}`);

  // Threshold defaults to blank — fill 1 (single owner = 1/1).
  log('Filling threshold...');
  await page.locator('input[type="number"]').first().fill('1');

  // Click deploy
  log('Clicking Deploy account...');
  const deployBtn = page.getByRole('button', { name: /deploy account/i });
  await deployBtn.click();

  // Wait for the operation to complete (success banner or redirect)
  log('Waiting for deploy transaction...');
  await waitForBanner(page, 'success');

  // Wait for indexer to discover the contract
  await waitForIndexer(
    'indexer discovers deployed contract',
    async () => {
      const contracts = await getContracts();
      return contracts.some((c: any) => c.address === contractAddress);
    }
  );

  // Verify
  const contract = await getContract(contractAddress);
  expect(contract).not.toBeNull();
  log(`Contract discovered by indexer: ${contract.address}`);

  // Fund the contract with extra MINA so it can execute transfer proposals
  await fundContract(contractAddress, accounts[0], 10);
});

// ---------------------------------------------------------------------------
// 2. Verify contract initialized (account1 as owner, threshold 1/1)
//
// The on-chain flow deploys + initializes in a single transaction, so there
// is no separate setup UI step here. This test just confirms the indexer
// picked up the owner/threshold events that the deploy emitted.
// ---------------------------------------------------------------------------

test('2. Verify contract initialized (account1 as owner, threshold=1/1)', async () => {
  log('=== Step 2: Verify initial contract state ===');

  await waitForIndexer(
    'indexer processes initial owner + threshold events',
    async () => {
      const owners = await getOwners(contractAddress);
      return owners.some(
        (o: any) => o.address === accounts[0].publicKey && o.active
      );
    }
  );

  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(1);
  expect(contract.numOwners).toBe(1);
  log(`Setup verified: threshold=${contract.threshold}, numOwners=${contract.numOwners}`);

  const owners = await getOwners(contractAddress);
  const activeOwners = owners.filter((o: any) => o.active);
  expect(activeOwners).toHaveLength(1);
  expect(activeOwners[0].address).toBe(accounts[0].publicKey);
  log(`Owner verified: ${activeOwners[0].address}`);
});

// ---------------------------------------------------------------------------
// 3. Propose: add account2 as new owner
// ---------------------------------------------------------------------------

test('3. Propose add owner (account2)', async () => { const page = sharedPage;
  log('=== Step 3: Propose add owner ===');
  // Direct nav to /transactions/new with ?type= preselects the tx type,
  // bypassing the old "click New Proposal → select Add Owner" steps.
  await gotoWithWallet('/transactions/new?type=addOwner', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Fill new owner address
  const ownerInput = page.locator('input[placeholder*="B62"]').first();
  await ownerInput.waitFor({ state: 'visible', timeout: 5_000 });
  await ownerInput.fill(accounts[1].publicKey);

  // Set expiry to 0 (no expiry)
  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  // Submit
  log('Submitting proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  // Wait for operation
  log('Waiting for propose transaction...');
  await waitForBanner(page, 'success');

  // Wait for indexer
  await waitForIndexer(
    'indexer processes add-owner proposal',
    async () => {
      const proposals = await getProposals(contractAddress);
      return proposals.some(
        (p: any) => p.txType === 'addOwner' && p.status === 'pending'
      );
    }
  );

  // Verify
  const proposals = await getProposals(contractAddress);
  const addOwnerProposal = proposals.find(
    (p: any) => p.txType === 'addOwner' && p.status === 'pending'
  );
  expect(addOwnerProposal).toBeDefined();
  expect(addOwnerProposal.approvalCount).toBe(1); // auto-approved by proposer
  proposalHashes.push(addOwnerProposal.proposalHash);
  log(
    `Proposal created: hash=${addOwnerProposal.proposalHash.slice(0, 12)}..., approvals=${addOwnerProposal.approvalCount}`
  );
});

// ---------------------------------------------------------------------------
// 4. Execute add owner proposal
// ---------------------------------------------------------------------------

test('4. Execute add owner proposal', async () => { const page = sharedPage;
  log('=== Step 4: Execute add owner ===');
  const proposalHash = proposalHashes[0];
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Click "Execute Proposal"
  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  // Wait for indexer
  await waitForIndexer(
    'indexer processes owner change execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  // Verify proposal is executed
  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('executed');
  log(`Proposal executed at block ${proposal.executedAtBlock}`);

  // Verify account2 is now an active owner
  await waitForIndexer(
    'indexer updates owner list',
    async () => {
      const owners = await getOwners(contractAddress);
      return owners.some(
        (o: any) => o.address === accounts[1].publicKey && o.active
      );
    }
  );

  const owners = await getOwners(contractAddress);
  const activeOwners = owners.filter((o: any) => o.active);
  expect(activeOwners).toHaveLength(2);
  log(`Owners: ${activeOwners.map((o: any) => o.address.slice(0, 12) + '...').join(', ')}`);
});

// ---------------------------------------------------------------------------
// 5. Propose: change threshold to 2/2
// ---------------------------------------------------------------------------

test('5. Propose change threshold to 2/2', async () => { const page = sharedPage;
  log('=== Step 5: Propose threshold change ===');
  // Wait for the backend to reflect numOwners=2 — the ProposalForm clamps
  // its threshold input against multisig.numOwners reported by useMultisig.
  log('Waiting for numOwners to update to 2...');
  await waitForIndexer(
    'numOwners = 2 in backend',
    async () => {
      const contract = await getContract(contractAddress);
      return contract?.numOwners === 2;
    }
  );

  await gotoWithWallet('/transactions/new?type=changeThreshold', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Backend has numOwners=2 but the UI may still be on the previous 15s
  // useMultisig poll. Wait for the form to actually render "out of 2" before
  // filling, otherwise input max=1 and the submit fails validation.
  log('Waiting for form to reflect numOwners=2...');
  await expect(page.getByText('out of 2')).toBeVisible({ timeout: 30_000 });

  // Set new threshold to 2
  const thresholdInput = page.locator('input[type="number"]').first();
  await thresholdInput.fill('2');

  // Set expiry to 0
  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  // Submit
  log('Submitting threshold proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  log('Waiting for propose transaction...');
  await waitForBanner(page, 'success');

  // Wait for indexer
  await waitForIndexer(
    'indexer processes threshold proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'changeThreshold');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const thresholdProposal = proposals.find(
    (p: any) => p.txType === 'changeThreshold'
  );
  expect(thresholdProposal).toBeDefined();
  proposalHashes.push(thresholdProposal.proposalHash);
  log(
    `Threshold proposal created: hash=${thresholdProposal.proposalHash.slice(0, 12)}...`
  );
});

// ---------------------------------------------------------------------------
// 6. Execute threshold change
// ---------------------------------------------------------------------------

test('6. Execute threshold change', async () => { const page = sharedPage;
  log('=== Step 6: Execute threshold change ===');
  const proposalHash = proposalHashes[1];
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes threshold change execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  // Verify threshold is now 2
  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(2);
  log(`Threshold updated: ${contract.threshold}/${contract.numOwners}`);
});

// ---------------------------------------------------------------------------
// 7. Propose: send MINA to account3
// ---------------------------------------------------------------------------

test('7. Propose send MINA to account3', async () => { const page = sharedPage;
  log('=== Step 7: Propose MINA transfer ===');
  await gotoWithWallet('/transactions/new?type=transfer', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // The transfer form uses a single textarea with `address,amount` per line
  // (see ProposalForm.tsx — parseTransferLines). 1 MINA to account3.
  const recipientsTextarea = page.locator('textarea').first();
  await recipientsTextarea.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientsTextarea.fill(`${accounts[2].publicKey},1`);

  // Set expiry to 0
  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  // Submit
  log('Submitting transfer proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  log('Waiting for propose transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes transfer proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'transfer');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const transferProposal = proposals.find(
    (p: any) => p.txType === 'transfer'
  );
  expect(transferProposal).toBeDefined();
  expect(transferProposal.approvalCount).toBe(1); // auto-approved by proposer
  proposalHashes.push(transferProposal.proposalHash);
  log(
    `Transfer proposal created: hash=${transferProposal.proposalHash.slice(0, 12)}..., approvals=${transferProposal.approvalCount}`
  );
});

// ---------------------------------------------------------------------------
// 8. Approve transfer (account2)
// ---------------------------------------------------------------------------

test('8. Approve transfer (account2)', async () => { const page = sharedPage;
  log('=== Step 8: Approve transfer (account2) ===');
  const proposalHash = proposalHashes[2];

  // Navigate as account2
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  // Click "Approve Proposal"
  log('Clicking Approve Proposal...');
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();

  log('Waiting for approve transaction...');
  await waitForBanner(page, 'success');

  // Wait for indexer to record the approval
  await waitForIndexer(
    'indexer processes approval',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.approvalCount >= 2;
    }
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.approvalCount).toBe(2);
  log(`Approval count: ${proposal.approvalCount}/${2} (threshold met)`);

  // Verify approval records
  const approvals = await getApprovals(contractAddress, proposalHash);
  expect(approvals).toHaveLength(2);
  log(
    `Approvers: ${approvals.map((a: any) => a.approver.slice(0, 12) + '...').join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// 9. Execute transfer (account2)
// ---------------------------------------------------------------------------

test('9. Execute transfer (account2)', async () => { const page = sharedPage;
  log('=== Step 9: Execute transfer (account2) ===');
  const proposalHash = proposalHashes[2];

  // Wait for the approval from step 8 to be fully settled on-chain
  // before attempting execute. The on-chain approvalRoot must reflect
  // the new approval, otherwise the Merkle witness will be invalid.
  log('Waiting for on-chain state to settle after approval...');
  await new Promise((r) => setTimeout(r, SETTLE_WAIT));

  // Navigate as account2
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  // Click "Execute Proposal"
  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  const bannerText = await waitForBanner(page, 'success');

  // Extract tx hash from banner and check its on-chain status
  const txHashMatch = bannerText.match(/5J[a-zA-Z0-9]+/);
  if (txHashMatch) {
    log(`Execute tx hash: ${txHashMatch[0]}`);
    // Give the node time to process, then check status
    await new Promise((r) => setTimeout(r, SETTLE_WAIT));
    await checkTxStatus(txHashMatch[0]);
  }

  await waitForIndexer(
    'indexer processes transfer execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      if (proposal) {
        log(`  Proposal status: ${proposal.status}, approvals: ${proposal.approvalCount}`);
      }
      return proposal?.status === 'executed';
    },
    360_000, // 6 min — last step, lightnet may be slow after many txs
    10_000
  );

  // Verify proposal is executed
  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('executed');
  log(`Transfer proposal executed at block ${proposal.executedAtBlock}`);

  // Verify the UI shows executed status
  await navigateTo(page, `/transactions/${proposalHash}`);
  const statusBadge = page.locator('text=executed').or(page.locator('text=Executed'));
  await expect(statusBadge.first()).toBeVisible({ timeout: 10_000 });
  log('UI shows executed status');

  log('Transfer execution verified');
});

// ---------------------------------------------------------------------------
// 10. Verify Settings page displays correct state
// ---------------------------------------------------------------------------

test('10. Verify Settings page', async () => { const page = sharedPage;
  log('=== Step 10: Verify Settings page ===');
  await gotoWithWallet('/settings', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Verify "Required Confirmations" section exists
  await expect(page.locator('text=Required Confirmations')).toBeVisible({ timeout: 10_000 });
  log('Required Confirmations section visible');

  // Verify owners section header shows count of 2
  await expect(page.locator('text=Owners (2)')).toBeVisible({ timeout: 10_000 });
  log('Owners count shows 2');

  // Verify contract info section labels
  await expect(page.locator('text=Config Nonce')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=Owners Commitment')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=Network ID')).toBeVisible({ timeout: 10_000 });
  log('Contract info section verified');
});

// ---------------------------------------------------------------------------
// 11. Verify Transactions page filtering
// ---------------------------------------------------------------------------

test('11. Verify Transactions page filtering', async () => { const page = sharedPage;
  log('=== Step 11: Verify Transactions page filtering ===');
  await gotoWithWallet('/transactions', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // After steps 1-9: 3 proposals total (addOwner=executed, changeThreshold=executed, transfer=executed)
  // All tab should show 3
  const allTab = page.locator('button', { hasText: /All/i }).first();
  await expect(allTab).toBeVisible({ timeout: 10_000 });
  const allText = await allTab.textContent();
  log(`All tab: ${allText}`);
  expect(allText).toContain('3');

  // Executed tab should show 3
  const executedTab = page.locator('button', { hasText: /Executed/i }).first();
  await executedTab.click();
  await page.waitForTimeout(1_000);
  const executedText = await executedTab.textContent();
  log(`Executed tab: ${executedText}`);
  expect(executedText).toContain('3');

  // Pending tab should show 0
  const pendingTab = page.locator('button', { hasText: /Pending/i }).first();
  const pendingText = await pendingTab.textContent();
  log(`Pending tab: ${pendingText}`);
  expect(pendingText).toContain('0');

  log('Transaction filtering verified');
});

// ---------------------------------------------------------------------------
// 12. Propose threshold change back to 1/2 (needed to enable owner removal)
// ---------------------------------------------------------------------------

test('12. Propose threshold change to 1/2', async () => { const page = sharedPage;
  log('=== Step 12: Propose threshold change to 1/2 ===');
  await gotoWithWallet('/transactions/new?type=changeThreshold', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Set threshold to 1
  const thresholdInput = page.locator('input[type="number"]').first();
  await thresholdInput.fill('1');

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting threshold proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes threshold-to-1 proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'changeThreshold');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const thresholdProposal = proposals.find(
    (p: any) => p.txType === 'changeThreshold'
  );
  expect(thresholdProposal).toBeDefined();
  proposalHashes.push(thresholdProposal.proposalHash);
  log(`Threshold-to-1 proposal: hash=${thresholdProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 13. Approve threshold change (account2)
// ---------------------------------------------------------------------------

test('13. Approve threshold change (account2)', async () => { const page = sharedPage;
  log('=== Step 13: Approve threshold change (account2) ===');
  const proposalHash = proposalHashes[3];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Approve Proposal...');
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();

  log('Waiting for approve transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes threshold approval',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.approvalCount >= 2;
    }
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.approvalCount).toBe(2);
  log(`Approval count: ${proposal.approvalCount}/2 (threshold met)`);
});

// ---------------------------------------------------------------------------
// 14. Execute threshold change to 1/2
// ---------------------------------------------------------------------------

test('14. Execute threshold change to 1/2', async () => { const page = sharedPage;
  log('=== Step 14: Execute threshold change to 1/2 ===');
  const proposalHash = proposalHashes[3];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes threshold change to 1',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(1);
  log(`Threshold changed: ${contract.threshold}/${contract.numOwners}`);
});

// ---------------------------------------------------------------------------
// 15. Propose remove owner (account2)
// ---------------------------------------------------------------------------

test('15. Propose remove owner (account2)', async () => { const page = sharedPage;
  log('=== Step 15: Propose remove owner ===');
  await gotoWithWallet('/transactions/new?type=removeOwner', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Test 14 just executed the threshold-to-1 change, but useMultisig polls
  // every 15s — the form may still see stale `currentThreshold=2` and render
  // the "Cannot remove an owner..." render-time warning, which blocks submit.
  // Wait for that warning to disappear before interacting.
  log('Waiting for UI to reflect post-execute threshold state...');
  await page.waitForFunction(
    () => !document.body.textContent?.includes(
      'Cannot remove an owner while it would go below the threshold'
    ),
    { timeout: 30_000 }
  );

  // The radio input has class `sr-only` (screen-reader-only) and is covered
  // by a sibling fake-radio div — Playwright can't click the input directly.
  // Click the label which wraps the row; native form behaviour toggles the
  // input. Also wait for account2 to appear in the list (useMultisig may
  // still be on the previous owner-list refresh).
  await expect(page.getByText(accounts[1].publicKey, { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.locator(`label:has-text("${accounts[1].publicKey}")`).click();

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting remove-owner proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes remove-owner proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'removeOwner');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const removeProposal = proposals.find(
    (p: any) => p.txType === 'removeOwner'
  );
  expect(removeProposal).toBeDefined();
  expect(removeProposal.approvalCount).toBe(1); // auto-approved, threshold=1
  proposalHashes.push(removeProposal.proposalHash);
  log(`Remove-owner proposal: hash=${removeProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 16. Execute remove owner
// ---------------------------------------------------------------------------

test('16. Execute remove owner', async () => { const page = sharedPage;
  log('=== Step 16: Execute remove owner ===');
  const proposalHash = proposalHashes[4];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes remove-owner execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  // Verify account2 is no longer an active owner
  await waitForIndexer(
    'indexer updates owner list after removal',
    async () => {
      const owners = await getOwners(contractAddress);
      const active = owners.filter((o: any) => o.active);
      return active.length === 1 && active[0].address === accounts[0].publicKey;
    }
  );

  const owners = await getOwners(contractAddress);
  const activeOwners = owners.filter((o: any) => o.active);
  expect(activeOwners).toHaveLength(1);
  expect(activeOwners[0].address).toBe(accounts[0].publicKey);
  log(`Owner removed. Active owners: ${activeOwners.length}`);

  const contract = await getContract(contractAddress);
  expect(contract.numOwners).toBe(1);
  log(`Contract state: threshold=${contract.threshold}, numOwners=${contract.numOwners}`);
});

// ---------------------------------------------------------------------------
// 17. Verify state after owner removal
// ---------------------------------------------------------------------------

test('17. Verify state after owner removal', async () => { const page = sharedPage;
  log('=== Step 17: Verify state after owner removal ===');
  // Dashboard moved from `/` to `/accounts/<address>` in the UI restructure.
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Dashboard delegate card should show "None"
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=None')).toBeVisible({ timeout: 10_000 });
  log('Delegate card shows None');
});

// ---------------------------------------------------------------------------
// 18. Propose set delegate (to account3)
// ---------------------------------------------------------------------------

test('18. Propose set delegate (account3)', async () => { const page = sharedPage;
  log('=== Step 18: Propose set delegate ===');
  await gotoWithWallet('/transactions/new?type=setDelegate', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Fill delegate address (account3)
  const delegateInput = page.locator('input[placeholder*="B62"]').first();
  await delegateInput.waitFor({ state: 'visible', timeout: 5_000 });
  await delegateInput.fill(accounts[2].publicKey);

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting delegate proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes delegate proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'setDelegate');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const delegateProposal = proposals.find(
    (p: any) => p.txType === 'setDelegate'
  );
  expect(delegateProposal).toBeDefined();
  proposalHashes.push(delegateProposal.proposalHash);
  log(`Delegate proposal: hash=${delegateProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 19. Execute set delegate
// ---------------------------------------------------------------------------

test('19. Execute set delegate', async () => { const page = sharedPage;
  log('=== Step 19: Execute set delegate ===');
  const proposalHash = proposalHashes[5];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes delegate execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  // Verify delegate is set in backend
  await waitForIndexer(
    'indexer updates delegate field',
    async () => {
      const contract = await getContract(contractAddress);
      return contract?.delegate != null && contract.delegate.length > 10;
    }
  );

  const contract = await getContract(contractAddress);
  log(`Delegate set to: ${contract.delegate}`);
});

// ---------------------------------------------------------------------------
// 20. Verify delegate card on Dashboard
// ---------------------------------------------------------------------------

test('20. Verify delegate card shows delegate', async () => { const page = sharedPage;
  log('=== Step 20: Verify delegate card ===');
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // The delegate card should show the account3 address (truncated)
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  const delegateText = page.locator(`text=${accounts[2].publicKey.slice(0, 8)}`);
  await expect(delegateText.first()).toBeVisible({ timeout: 10_000 });
  log('Dashboard shows delegate address');
});


// ---------------------------------------------------------------------------
// 21. Propose undelegate
// ---------------------------------------------------------------------------

test('21. Propose undelegate', async () => { const page = sharedPage;
  log('=== Step 21: Propose undelegate ===');
  await gotoWithWallet('/transactions/new?type=setDelegate', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Check the "Undelegate" checkbox
  log('Checking Undelegate checkbox...');
  const undelegateCheckbox = page.locator('input[type="checkbox"]').first();
  await undelegateCheckbox.waitFor({ state: 'visible', timeout: 5_000 });
  await undelegateCheckbox.check();

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting undelegate proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes undelegate proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'setDelegate');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const undelegateProposal = proposals.find(
    (p: any) => p.txType === 'setDelegate'
  );
  expect(undelegateProposal).toBeDefined();
  proposalHashes.push(undelegateProposal.proposalHash);
  log(`Undelegate proposal: hash=${undelegateProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 22. Execute undelegate
// ---------------------------------------------------------------------------

test('22. Execute undelegate', async () => { const page = sharedPage;
  log('=== Step 22: Execute undelegate ===');
  const proposalHash = proposalHashes[6];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes undelegate execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  // Verify delegate is reset (set to contract self or null)
  await waitForIndexer(
    'indexer updates delegate after undelegate',
    async () => {
      const contract = await getContract(contractAddress);
      // After undelegation, delegate is set to the contract's own address
      return contract?.delegate === contractAddress;
    }
  );

  const contract = await getContract(contractAddress);
  log(`Delegate after undelegate: ${contract.delegate}`);
});

// ---------------------------------------------------------------------------
// 23. Propose transfer with low expiry block (will expire before execution)
// ---------------------------------------------------------------------------

test('23. Propose transfer with near-future expiry', async () => { const page = sharedPage;
  log('=== Step 23: Propose transfer with expiry ===');

  // Get current block height from indexer status
  const status = await getIndexerStatus();
  const currentHeight = status?.latestChainHeight ?? status?.indexedHeight ?? 0;
  const expiryBlock = currentHeight + netConfig.expiryBlockOffset;
  log(`Current block height: ${currentHeight}, setting expiry: ${expiryBlock}`);

  await gotoWithWallet('/transactions/new?type=transfer', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // 0.5 MINA to account3 as a single textarea line.
  const recipientsTextarea = page.locator('textarea').first();
  await recipientsTextarea.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientsTextarea.fill(`${accounts[2].publicKey},0.5`);

  // Set the low expiry block
  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill(String(expiryBlock));
  }

  log('Submitting proposal with expiry...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes expiring transfer proposal',
    async () => {
      const proposals = await getProposals(contractAddress);
      return proposals.some(
        (p: any) => p.txType === 'transfer' && p.expiryBlock === String(expiryBlock)
      );
    }
  );

  const proposals = await getProposals(contractAddress);
  const expiringProposal = proposals.find(
    (p: any) => p.txType === 'transfer' && p.expiryBlock === String(expiryBlock)
  );
  expect(expiringProposal).toBeDefined();
  proposalHashes.push(expiringProposal.proposalHash);
  log(`Expiring proposal created: hash=${expiringProposal.proposalHash.slice(0, 12)}..., expiryBlock=${expiryBlock}`);
});

// ---------------------------------------------------------------------------
// 24. Wait for proposal to expire and verify status
// ---------------------------------------------------------------------------

test('24. Verify proposal expires and execute button is hidden', async () => { const page = sharedPage;
  log('=== Step 24: Verify proposal expiry ===');
  const proposalHash = proposalHashes[7];

  // Wait for the indexer to mark the proposal as expired
  log('Waiting for proposal to expire...');
  await waitForIndexer(
    'indexer marks proposal as expired',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'expired';
    },
    netConfig.mode === 'devnet' ? 2_400_000 : 180_000, // devnet: 40 min, lightnet: 3 min
    netConfig.indexerPollIntervalMs
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('expired');
  log(`Proposal status: ${proposal.status}`);

  // Navigate to the proposal detail page
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Verify status badge shows "Expired" (red)
  const expiredBadge = page.locator('text=expired').or(page.locator('text=Expired'));
  await expect(expiredBadge.first()).toBeVisible({ timeout: 10_000 });
  log('Status badge shows Expired');

  // Verify the Execute button is NOT visible
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await expect(executeBtn).not.toBeVisible({ timeout: 5_000 });
  log('Execute button is hidden for expired proposal');

  // Verify the Approve button is also NOT visible
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await expect(approveBtn).not.toBeVisible({ timeout: 5_000 });
  log('Approve button is hidden for expired proposal');
});

// ---------------------------------------------------------------------------
// 25. Verify final state
// ---------------------------------------------------------------------------

test('25. Verify state before subaccount tests', async () => { const page = sharedPage;
  log('=== Step 25: Verify state before subaccount tests ===');

  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  log('Delegate card visible on dashboard');

  await navigateTo(page, '/settings');
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Owners (1)')).toBeVisible({ timeout: 10_000 });
  log('Settings shows 1 owner');

  await navigateTo(page, '/transactions');
  await page.waitForTimeout(SHORT_WAIT);

  const executedTab = page.locator('button', { hasText: /Executed/i }).first();
  const executedText = await executedTab.textContent();
  log(`Executed tab: ${executedText}`);
  expect(executedText).toContain('7');

  const expiredTab = page.locator('button', { hasText: /Expired/i }).first();
  const expiredText = await expiredTab.textContent();
  log(`Expired tab: ${expiredText}`);
  expect(expiredText).toContain('1');

  const pendingTab = page.locator('button', { hasText: /Pending/i }).first();
  const pendingText = await pendingTab.textContent();
  log(`Pending tab: ${pendingText}`);
  expect(pendingText).toContain('0');

  log('State checkpoint passed');
});

// ===========================================================================
// SUBACCOUNT LIFECYCLE
// ===========================================================================

// ---------------------------------------------------------------------------
// 26. Propose CREATE_CHILD (subaccount) on parent
// ---------------------------------------------------------------------------

test('26. Propose CREATE_CHILD on parent', async () => { const page = sharedPage;
  log('=== Step 26: Propose CREATE_CHILD ===');

  await gotoWithWallet(`/accounts/new?parent=${contractAddress}`, accounts[0]);

  await page.waitForFunction(
    (addr: string) => document.body.textContent?.includes(addr.slice(0, 6)),
    accounts[0].publicKey,
    { timeout: 30_000 }
  );

  log('Advancing wizard to step 2...');
  await page.getByRole('button', { name: /^next$/i }).click();

  log('Waiting for child keypair generation...');
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Generating keypair'),
    { timeout: 60_000 }
  );

  const addressEl = page
    .getByText('Contract Address', { exact: true })
    .locator('xpath=following-sibling::p[1]');
  await addressEl.waitFor({ state: 'visible', timeout: 10_000 });
  childAddress = (await addressEl.textContent())?.trim() ?? '';
  expect(childAddress).toMatch(/^B62/);
  expect(childAddress).not.toBe(contractAddress);
  log(`Child address: ${childAddress}`);

  log('Filling threshold...');
  await page.locator('input[type="number"]').first().fill('1');

  log('Clicking Propose subaccount...');
  await page.getByRole('button', { name: /propose subaccount/i }).click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes CREATE_CHILD proposal',
    async () => {
      const proposals = await getProposals(contractAddress);
      return proposals.some(
        (p: any) => p.txType === 'createChild' && p.childAccount === childAddress
      );
    }
  );

  const created = (await getProposals(contractAddress)).find(
    (p: any) => p.txType === 'createChild' && p.childAccount === childAddress
  );
  expect(created).toBeDefined();
  expect(created.approvalCount).toBe(1);
  proposalHashes.push(created.proposalHash);
  log(`CREATE_CHILD proposal: hash=${created.proposalHash.slice(0, 12)}..., approvals=${created.approvalCount}`);
});

// ---------------------------------------------------------------------------
// 27. Finalize subaccount deployment (executeSetupChild on the new child)
// ---------------------------------------------------------------------------

test('27. Finalize subaccount deployment', async () => { const page = sharedPage;
  log('=== Step 27: Finalize subaccount deployment ===');

  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const finalizeBtn = page.getByRole('button', { name: /finalize deployment/i });
  await finalizeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  log('Clicking Finalize deployment...');
  await finalizeBtn.click();

  log('Waiting for executeSetupChild transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer discovers child contract + marks parent proposal executed',
    async () => {
      const child = await getContract(childAddress);
      const parent = await getProposal(contractAddress, proposalHashes[proposalHashes.length - 1]);
      return child !== null && parent?.status === 'executed';
    },
    180_000,
    netConfig.indexerPollIntervalMs
  );

  const child = await getContract(childAddress);
  expect(child.parent).toBe(contractAddress);
  expect(child.childMultiSigEnabled).toBe(true);
  expect(child.threshold).toBe(1);
  expect(child.numOwners).toBe(1);
  log(`Child contract indexed: parent=${child.parent.slice(0, 12)}..., threshold=${child.threshold}/${child.numOwners}`);

  const parentProposal = await getProposal(contractAddress, proposalHashes[proposalHashes.length - 1]);
  expect(parentProposal.status).toBe('executed');
  log(`Parent CREATE_CHILD proposal marked executed`);
});

// ---------------------------------------------------------------------------
// 28. Verify subaccount shows up in the UI tree + child detail page renders
// ---------------------------------------------------------------------------

test('28. Verify subaccount in UI tree', async () => { const page = sharedPage;
  log('=== Step 28: Verify subaccount in UI ===');

  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const childRow = page.locator('a', {
    has: page.locator(`text=${childAddress.slice(0, 10)}`),
  });
  await expect(childRow).toBeVisible({ timeout: 15_000 });
  log('Child row visible in account tree');

  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Subaccounts (1)')).toBeVisible({ timeout: 10_000 });
  log('Subaccounts (1) card visible on parent dashboard');

  await gotoWithWallet(`/accounts/${childAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Parent Account')).toBeVisible({ timeout: 10_000 });
  log('Child detail renders with Parent card');
});

// ---------------------------------------------------------------------------
// 29. Fund child contract
// ---------------------------------------------------------------------------

test('29. Fund contracts for allocation tests', async () => {
  log('=== Step 29: Fund contracts for allocation tests ===');
  await fundContract(contractAddress, accounts[0], 10);
  log('Parent contract topped up with 10 MINA');
  await fundContract(childAddress, accounts[0], 5);
  log('Child contract funded with 5 MINA');
});

// ---------------------------------------------------------------------------
// 30. Propose ALLOCATE_CHILD (parent → child)
// ---------------------------------------------------------------------------

test('30. Propose ALLOCATE_CHILD', async () => { const page = sharedPage;
  log('=== Step 30: Propose ALLOCATE_CHILD ===');
  // Navigate to parent first to make it the active contract (child was active
  // after test 28's detail-page visit).
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await gotoWithWallet('/transactions/new?type=allocateChild', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const recipientsTextarea = page.locator('textarea').first();
  await recipientsTextarea.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientsTextarea.fill(`${childAddress},2`);

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting allocate proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes ALLOCATE_CHILD proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'allocateChild');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const allocateProposal = proposals.find((p: any) => p.txType === 'allocateChild');
  expect(allocateProposal).toBeDefined();
  proposalHashes.push(allocateProposal.proposalHash);
  log(`ALLOCATE_CHILD proposal: hash=${allocateProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 31. Execute ALLOCATE_CHILD
// ---------------------------------------------------------------------------

test('31. Execute ALLOCATE_CHILD', async () => { const page = sharedPage;
  log('=== Step 31: Execute ALLOCATE_CHILD ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes ALLOCATE_CHILD execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('executed');
  log(`ALLOCATE_CHILD executed`);
});

// ---------------------------------------------------------------------------
// 32. Propose RECLAIM_CHILD (child → parent)
// ---------------------------------------------------------------------------

test('32. Propose RECLAIM_CHILD', async () => { const page = sharedPage;
  log('=== Step 32: Propose RECLAIM_CHILD ===');

  await gotoWithWallet('/transactions/new?type=reclaimChild', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Select child in radio button group
  const childLabel = page.locator(`label:has-text("${childAddress.slice(0, 10)}")`);
  await childLabel.waitFor({ state: 'visible', timeout: 10_000 });
  await childLabel.click();

  // Fill reclaim amount
  const amountInput = page.locator('input[placeholder="1.0"]');
  await amountInput.waitFor({ state: 'visible', timeout: 5_000 });
  await amountInput.fill('1');

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting reclaim proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes RECLAIM_CHILD proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'reclaimChild');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const reclaimProposal = proposals.find((p: any) => p.txType === 'reclaimChild');
  expect(reclaimProposal).toBeDefined();
  proposalHashes.push(reclaimProposal.proposalHash);
  log(`RECLAIM_CHILD proposal: hash=${reclaimProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 33. Execute RECLAIM_CHILD
// ---------------------------------------------------------------------------

test('33. Execute RECLAIM_CHILD', async () => { const page = sharedPage;
  log('=== Step 33: Execute RECLAIM_CHILD ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes RECLAIM_CHILD execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    },
    360_000,
    10_000
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('executed');
  log(`RECLAIM_CHILD executed`);
});

// ---------------------------------------------------------------------------
// 34. Propose ENABLE_CHILD_MULTI_SIG (disable)
// ---------------------------------------------------------------------------

test('34. Propose ENABLE_CHILD_MULTI_SIG (disable)', async () => { const page = sharedPage;
  log('=== Step 34: Propose enableChildMultiSig (disable) ===');
  // Ensure parent is the active contract after page recycle
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await gotoWithWallet('/transactions/new?type=enableChildMultiSig', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const childLabel = page.locator(`label:has-text("${childAddress.slice(0, 10)}")`);
  await childLabel.waitFor({ state: 'visible', timeout: 10_000 });
  await childLabel.click();

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting enableChildMultiSig proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes enableChildMultiSig proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'enableChildMultiSig');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const toggleProposal = proposals.find((p: any) => p.txType === 'enableChildMultiSig');
  expect(toggleProposal).toBeDefined();
  proposalHashes.push(toggleProposal.proposalHash);
  log(`enableChildMultiSig proposal: hash=${toggleProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 35. Execute ENABLE_CHILD_MULTI_SIG (disable)
// ---------------------------------------------------------------------------

test('35. Execute ENABLE_CHILD_MULTI_SIG (disable)', async () => { const page = sharedPage;
  log('=== Step 35: Execute enableChildMultiSig (disable) ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes enableChildMultiSig execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    }
  );

  // Verify child multi-sig is now disabled
  await waitForIndexer(
    'child contract reflects multi-sig disabled',
    async () => {
      const child = await getContract(childAddress);
      return child?.childMultiSigEnabled === false;
    }
  );

  const child = await getContract(childAddress);
  expect(child.childMultiSigEnabled).toBe(false);
  log(`Child multi-sig disabled: ${child.childMultiSigEnabled}`);
});

// ---------------------------------------------------------------------------
// 36. Propose DESTROY_CHILD
// ---------------------------------------------------------------------------

test('36. Propose DESTROY_CHILD', async () => { const page = sharedPage;
  log('=== Step 36: Propose destroyChild ===');
  await gotoWithWallet('/transactions/new?type=destroyChild', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const childLabel = page.locator(`label:has-text("${childAddress.slice(0, 10)}")`);
  await childLabel.waitFor({ state: 'visible', timeout: 10_000 });
  await childLabel.click();

  // Check confirmation checkbox
  const confirmCheckbox = page.locator('input[type="checkbox"]').first();
  await confirmCheckbox.waitFor({ state: 'visible', timeout: 5_000 });
  await confirmCheckbox.check();

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting destroy proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes destroyChild proposal',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'destroyChild');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const destroyProposal = proposals.find((p: any) => p.txType === 'destroyChild');
  expect(destroyProposal).toBeDefined();
  proposalHashes.push(destroyProposal.proposalHash);
  log(`destroyChild proposal: hash=${destroyProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 37. Execute DESTROY_CHILD
// ---------------------------------------------------------------------------

test('37. Execute DESTROY_CHILD', async () => { const page = sharedPage;
  log('=== Step 37: Execute destroyChild ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];

  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes destroyChild execution',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      return proposal?.status === 'executed';
    },
    360_000,
    10_000
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('executed');
  log(`destroyChild executed`);
});

// ===========================================================================
// DELETE PROPOSAL FLOW
// ===========================================================================

// ---------------------------------------------------------------------------
// 38. Propose a transfer, then create a delete proposal for it
// ---------------------------------------------------------------------------

test('38. Propose transfer then delete it', async () => { const page = sharedPage;
  log('=== Step 38: Propose transfer + delete ===');

  // Ensure parent is the active contract after page recycle
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // First, create a normal transfer proposal
  await gotoWithWallet('/transactions/new?type=transfer', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const recipientsTextarea = page.locator('textarea').first();
  await recipientsTextarea.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientsTextarea.fill(`${accounts[2].publicKey},0.1`);

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill('0');
  }

  log('Submitting transfer proposal to delete later...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes transfer proposal (to be deleted)',
    async () => {
      const proposals = await getProposals(contractAddress, 'pending');
      return proposals.some((p: any) => p.txType === 'transfer');
    }
  );

  const proposals = await getProposals(contractAddress, 'pending');
  const targetProposal = proposals.find((p: any) => p.txType === 'transfer');
  expect(targetProposal).toBeDefined();
  const targetHash = targetProposal.proposalHash;
  const targetNonce = targetProposal.nonce;
  proposalHashes.push(targetHash);
  log(`Target proposal: hash=${targetHash.slice(0, 12)}..., nonce=${targetNonce}`);

  // Navigate to the proposal detail and click Delete
  await gotoWithWallet(`/transactions/${targetHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Delete Proposal...');
  const deleteBtn = page.getByRole('button', { name: /delete proposal/i });
  await deleteBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await deleteBtn.click();

  // Should redirect to /transactions/new?mode=delete&...
  await page.waitForFunction(
    () => window.location.search.includes('mode=delete'),
    { timeout: 10_000 }
  );

  // Verify delete mode UI
  await expect(page.locator('text=Delete pending proposal')).toBeVisible({ timeout: 5_000 });
  log('Delete mode UI visible');

  // Submit the delete proposal
  log('Submitting delete proposal...');
  const deleteSubmitBtn = page.getByRole('button', { name: /create delete proposal/i });
  await deleteSubmitBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await deleteSubmitBtn.click();
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes delete proposal',
    async () => {
      const allProposals = await getProposals(contractAddress, 'pending');
      return allProposals.some((p: any) => p.txType === 'transfer' && p.proposalHash !== targetHash);
    }
  );

  const allProposals = await getProposals(contractAddress, 'pending');
  const deleteProposal = allProposals.find(
    (p: any) => p.txType === 'transfer' && p.proposalHash !== targetHash
  );
  expect(deleteProposal).toBeDefined();
  proposalHashes.push(deleteProposal.proposalHash);
  log(`Delete proposal created: hash=${deleteProposal.proposalHash.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 39. Execute delete proposal and verify invalidation
// ---------------------------------------------------------------------------

test('39. Execute delete proposal and verify invalidation', async () => { const page = sharedPage;
  log('=== Step 39: Execute delete proposal ===');
  const deleteProposalHash = proposalHashes[proposalHashes.length - 1];
  const targetProposalHash = proposalHashes[proposalHashes.length - 2];

  await gotoWithWallet(`/transactions/${deleteProposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for execute transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer processes delete execution + marks target invalidated',
    async () => {
      const deleteP = await getProposal(contractAddress, deleteProposalHash);
      const targetP = await getProposal(contractAddress, targetProposalHash);
      return deleteP?.status === 'executed' && targetP?.status === 'invalidated';
    },
    360_000,
    10_000
  );

  const deleteP = await getProposal(contractAddress, deleteProposalHash);
  expect(deleteP.status).toBe('executed');
  log(`Delete proposal executed`);

  const targetP = await getProposal(contractAddress, targetProposalHash);
  expect(targetP.status).toBe('invalidated');
  log(`Target proposal invalidated`);

  // Verify Invalidated tab on transactions page
  await navigateTo(page, '/transactions');
  await page.waitForTimeout(SHORT_WAIT);

  const invalidatedTab = page.locator('button', { hasText: /Invalidated/i }).first();
  const invalidatedText = await invalidatedTab.textContent();
  log(`Invalidated tab: ${invalidatedText}`);
  expect(invalidatedText).toContain('2');
});

// ===========================================================================
// FINAL STATE
// ===========================================================================

// ---------------------------------------------------------------------------
// 40. Verify final state after all operations
// ---------------------------------------------------------------------------

test('40. Verify final state', async () => { const page = sharedPage;
  log('=== Step 40: Verify final state ===');

  // Settings — 1 owner, threshold 1
  await gotoWithWallet('/settings', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Owners (1)')).toBeVisible({ timeout: 10_000 });
  log('Settings shows 1 owner');

  // Transactions — count check
  await navigateTo(page, '/transactions');
  await page.waitForTimeout(SHORT_WAIT);

  const pendingTab = page.locator('button', { hasText: /Pending/i }).first();
  const pendingText = await pendingTab.textContent();
  log(`Pending tab: ${pendingText}`);
  expect(pendingText).toContain('0');

  const expiredTab = page.locator('button', { hasText: /Expired/i }).first();
  const expiredText = await expiredTab.textContent();
  log(`Expired tab: ${expiredText}`);
  expect(expiredText).toContain('1');

  const invalidatedTab = page.locator('button', { hasText: /Invalidated/i }).first();
  const invalidatedText = await invalidatedTab.textContent();
  log(`Invalidated tab: ${invalidatedText}`);
  expect(invalidatedText).toContain('2');

  // Final dump
  log('\n=== Final State ===');
  await dumpState(contractAddress);
  log('\n=== All 40 steps completed successfully! ===');
});

// ===========================================================================
// FORM VALIDATION (no on-chain transactions)
// ===========================================================================

// ---------------------------------------------------------------------------
// 41. Transfer form validation
// ---------------------------------------------------------------------------

test('41. Transfer form validation', async () => { const page = sharedPage;
  log('=== Step 41: Transfer form validation ===');
  await gotoWithWallet('/transactions/new?type=transfer', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const recipientsTextarea = page.locator('textarea').first();
  await recipientsTextarea.waitFor({ state: 'visible', timeout: 5_000 });

  // Invalid address
  await recipientsTextarea.fill('invalidaddress,1');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await page.waitForTimeout(1_000);
  const pageText = await page.textContent('body');
  expect(pageText).toMatch(/invalid|error|address/i);
  log('Invalid address rejected');

  // Empty textarea
  await recipientsTextarea.fill('');
  await submitBtn.click();
  await page.waitForTimeout(1_000);
  log('Empty form handled');
});

// ---------------------------------------------------------------------------
// 42. Add owner validation
// ---------------------------------------------------------------------------

test('42. Add owner validation', async () => { const page = sharedPage;
  log('=== Step 42: Add owner validation ===');
  await gotoWithWallet('/transactions/new?type=addOwner', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Try adding current owner (duplicate)
  const ownerInput = page.locator('input[placeholder*="B62"]').first();
  await ownerInput.waitFor({ state: 'visible', timeout: 5_000 });
  await ownerInput.fill(accounts[0].publicKey);

  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await page.waitForTimeout(1_000);
  const pageText = await page.textContent('body');
  expect(pageText).toMatch(/already.*owner/i);
  log('Duplicate owner rejected');
});

// ---------------------------------------------------------------------------
// 43. Threshold validation
// ---------------------------------------------------------------------------

test('43. Threshold validation', async () => { const page = sharedPage;
  log('=== Step 43: Threshold validation ===');
  await gotoWithWallet('/transactions/new?type=changeThreshold', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Try threshold > numOwners (currently 1 owner)
  const thresholdInput = page.locator('input[type="number"]').first();
  await thresholdInput.waitFor({ state: 'visible', timeout: 5_000 });
  await thresholdInput.fill('5');

  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await page.waitForTimeout(1_000);
  // The input should be clamped by max attribute or show an error
  const inputMax = await thresholdInput.getAttribute('max');
  log(`Threshold input max attribute: ${inputMax}`);

  // Same threshold as current (1/1) → should show error
  await thresholdInput.fill('1');
  await submitBtn.click();
  await page.waitForTimeout(1_000);
  const body = await page.textContent('body');
  expect(body).toMatch(/same.*current/i);
  log('Same-threshold rejection verified');
});

// ===========================================================================
// CORNER CASE TESTS (UI-only, no on-chain transactions)
// ===========================================================================

// ---------------------------------------------------------------------------
// 44. Navigate to non-existent proposal
// ---------------------------------------------------------------------------

test('44. Navigate to non-existent proposal hash', async () => { const page = sharedPage;
  log('=== Step 44: Non-existent proposal ===');
  const fakeHash = '12345678901234567890';
  await gotoWithWallet(`/transactions/${fakeHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const body = await page.textContent('body');
  // Should show "not found" or redirect — not crash
  const hasNotFound = /not found|no proposal|does not exist/i.test(body ?? '');
  const onTransactionsList = page.url().includes('/transactions') && !page.url().includes(fakeHash);
  expect(hasNotFound || onTransactionsList).toBe(true);
  log(`Non-existent proposal handled: ${hasNotFound ? 'not-found message' : 'redirected to list'}`);
});

// ---------------------------------------------------------------------------
// 45. Transfer form: malformed lines, zero amount, duplicate recipients
// ---------------------------------------------------------------------------

test('45. Transfer form parsing edge cases', async () => { const page = sharedPage;
  log('=== Step 45: Transfer form parsing edge cases ===');
  await gotoWithWallet('/transactions/new?type=transfer', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const textarea = page.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });

  // Missing comma → "expected address,amount"
  await textarea.fill('B62qooZ8LNHjSomething');
  await page.waitForTimeout(500);
  let body = await page.textContent('body');
  expect(body).toMatch(/expected.*address.*amount/i);
  log('Missing comma rejected');

  // Zero amount → "invalid amount" (parseMinaToNanomina rejects 0)
  await textarea.fill(`${accounts[2].publicKey},0`);
  await submitBtn.click();
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/invalid amount/i);
  log('Zero amount rejected');

  // Negative amount → "invalid amount"
  await textarea.fill(`${accounts[2].publicKey},-1`);
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/invalid amount/i);
  log('Negative amount rejected');

  // Duplicate recipients → "duplicate recipient"
  await textarea.fill(`${accounts[1].publicKey},1\n${accounts[1].publicKey},2`);
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/duplicate recipient/i);
  log('Duplicate recipient rejected');

  // Extra commas → "expected address,amount"
  await textarea.fill(`${accounts[2].publicKey},1,extra`);
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/expected.*address.*amount/i);
  log('Extra commas rejected');
});

// ---------------------------------------------------------------------------
// 46. Remove owner validation: below threshold
// ---------------------------------------------------------------------------

test('46. Remove owner validation edge cases', async () => { const page = sharedPage;
  log('=== Step 46: Remove owner validation ===');
  await gotoWithWallet('/transactions/new?type=removeOwner', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Currently 1 owner, threshold 1 → removing would drop below threshold
  const removeSelect = page.locator('select').first();
  if (await removeSelect.isVisible().catch(() => false)) {
    await removeSelect.selectOption(accounts[0].publicKey);
  } else {
    const removeInput = page.locator('input[placeholder*="B62"]').first();
    if (await removeInput.isVisible().catch(() => false)) {
      await removeInput.fill(accounts[0].publicKey);
    }
  }

  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await page.waitForTimeout(1_000);

  const body = await page.textContent('body');
  // Should show "reduce threshold first" error
  expect(body).toMatch(/reduce.*threshold|cannot.*remove|below.*threshold/i);
  log('Remove-below-threshold rejected');

  // Try removing a non-owner address
  const nonOwnerInput = page.locator('input[placeholder*="B62"]').first();
  if (await nonOwnerInput.isVisible().catch(() => false)) {
    await nonOwnerInput.fill(accounts[2].publicKey);
    await submitBtn.click();
    await page.waitForTimeout(1_000);
    const bodyAfter = await page.textContent('body');
    expect(bodyAfter).toMatch(/not.*current.*owner/i);
    log('Non-owner removal rejected');
  }
});

// ---------------------------------------------------------------------------
// 47. Delegate form: invalid address, undelegate toggle
// ---------------------------------------------------------------------------

test('47. Delegate form validation', async () => { const page = sharedPage;
  log('=== Step 47: Delegate form validation ===');
  await gotoWithWallet('/transactions/new?type=setDelegate', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // The delegate form should have a text input for the delegate address
  // and possibly an "undelegate" checkbox/toggle
  const delegateInput = page.locator('input[placeholder*="B62"]').first();
  if (await delegateInput.isVisible().catch(() => false)) {
    // Empty delegate → should require an address
    await delegateInput.fill('');
    const submitBtn = page.getByRole('button', { name: /submit proposal/i });
    await submitBtn.click();
    await page.waitForTimeout(500);
    log('Empty delegate submission attempted');

    // Invalid address format
    await delegateInput.fill('notavalidaddress');
    await submitBtn.click();
    await page.waitForTimeout(500);
    log('Invalid delegate address attempted');
  }

  // Check for undelegate toggle/checkbox
  const undelegateToggle = page.locator('input[type="checkbox"]').first();
  if (await undelegateToggle.isVisible().catch(() => false)) {
    await undelegateToggle.check();
    await page.waitForTimeout(500);
    const body = await page.textContent('body');
    // When undelegate is checked, the delegate input should be hidden/disabled
    log(`Undelegate toggle checked, page state: ${body?.includes('Undelegate') ? 'has Undelegate label' : 'no label'}`);
    await undelegateToggle.uncheck();
  }
  log('Delegate form validation checked');
});

// ---------------------------------------------------------------------------
// 48. Destroy subaccount without confirmation checkbox
// ---------------------------------------------------------------------------

test('48. Destroy subaccount form requires confirmation', async () => { const page = sharedPage;
  log('=== Step 48: Destroy confirmation required ===');

  // Ensure parent contract is active
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await gotoWithWallet('/transactions/new?type=destroyChild', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const body = await page.textContent('body');
  // If there are no children (destroyed in test 37), the form should say so
  if (/no.*subaccount|no.*indexed/i.test(body ?? '')) {
    log('No subaccounts available (destroyed in test 37) — validation skipped');
    return;
  }

  // If children exist, try submitting without checking the confirm box
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();
  await page.waitForTimeout(1_000);
  const bodyAfter = await page.textContent('body');
  expect(bodyAfter).toMatch(/confirm.*destroy|drains.*subaccount/i);
  log('Destroy without confirmation rejected');
});

// ---------------------------------------------------------------------------
// 49. Nonce validation: zero, negative, decimal
// ---------------------------------------------------------------------------

test('49. Nonce validation edge cases', async () => { const page = sharedPage;
  log('=== Step 49: Nonce validation ===');
  await gotoWithWallet('/transactions/new?type=transfer', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Fill valid recipients so nonce is the only validation target
  const textarea = page.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  await textarea.fill(`${accounts[2].publicKey},1`);

  const nonceInput = page.locator('input').first();
  await nonceInput.waitFor({ state: 'visible', timeout: 5_000 });

  const submitBtn = page.getByRole('button', { name: /submit proposal/i });

  // Nonce = 0 → "must be a positive integer"
  await nonceInput.fill('0');
  await submitBtn.click();
  await page.waitForTimeout(500);
  let body = await page.textContent('body');
  expect(body).toMatch(/positive integer|must be greater/i);
  log('Nonce=0 rejected');

  // Nonce = -1 → "must be a positive integer"
  await nonceInput.fill('-1');
  await submitBtn.click();
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/positive integer/i);
  log('Nonce=-1 rejected');

  // Nonce = 1.5 → "must be a positive integer"
  await nonceInput.fill('1.5');
  await submitBtn.click();
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/positive integer/i);
  log('Nonce=1.5 rejected');

  // Nonce = "abc" → "must be a positive integer"
  await nonceInput.fill('abc');
  await submitBtn.click();
  await page.waitForTimeout(500);
  body = await page.textContent('body');
  expect(body).toMatch(/positive integer/i);
  log('Nonce=abc rejected');
});

// ---------------------------------------------------------------------------
// 50. Proposal detail: executed proposal has no approve/execute buttons
// ---------------------------------------------------------------------------

test('50. Executed proposal has no action buttons', async () => { const page = sharedPage;
  log('=== Step 50: Executed proposal action buttons ===');

  // Find an executed proposal
  const proposals = await getProposals(contractAddress, 'executed');
  expect(proposals.length).toBeGreaterThan(0);
  const executedProposal = proposals[0];
  log(`Checking executed proposal: ${executedProposal.proposalHash.slice(0, 12)}...`);

  await gotoWithWallet(`/transactions/${executedProposal.proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // The page should show the proposal details but no approve/execute buttons
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  const deleteBtn = page.getByRole('button', { name: /delete proposal/i });

  expect(await approveBtn.isVisible().catch(() => false)).toBe(false);
  expect(await executeBtn.isVisible().catch(() => false)).toBe(false);
  expect(await deleteBtn.isVisible().catch(() => false)).toBe(false);
  log('No action buttons on executed proposal');

  // Should show "Executed" status badge
  const body = await page.textContent('body');
  expect(body).toMatch(/executed/i);
  log('Executed status badge visible');
});

// ---------------------------------------------------------------------------
// 51. Invalidated proposal has no action buttons
// ---------------------------------------------------------------------------

test('51. Invalidated proposal has no action buttons', async () => { const page = sharedPage;
  log('=== Step 51: Invalidated proposal action buttons ===');

  const proposals = await getProposals(contractAddress, 'invalidated');
  expect(proposals.length).toBeGreaterThan(0);
  const invalidatedProposal = proposals[0];
  log(`Checking invalidated proposal: ${invalidatedProposal.proposalHash.slice(0, 12)}...`);

  await gotoWithWallet(`/transactions/${invalidatedProposal.proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });

  expect(await approveBtn.isVisible().catch(() => false)).toBe(false);
  expect(await executeBtn.isVisible().catch(() => false)).toBe(false);
  log('No action buttons on invalidated proposal');

  const body = await page.textContent('body');
  expect(body).toMatch(/invalidated/i);
  log('Invalidated status badge visible');
});

// ---------------------------------------------------------------------------
// 52. Expired proposal has no execute button
// ---------------------------------------------------------------------------

test('52. Expired proposal has no execute button', async () => { const page = sharedPage;
  log('=== Step 52: Expired proposal action buttons ===');

  const proposals = await getProposals(contractAddress, 'expired');
  expect(proposals.length).toBeGreaterThan(0);
  const expiredProposal = proposals[0];
  log(`Checking expired proposal: ${expiredProposal.proposalHash.slice(0, 12)}...`);

  await gotoWithWallet(`/transactions/${expiredProposal.proposalHash}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  expect(await executeBtn.isVisible().catch(() => false)).toBe(false);
  log('No execute button on expired proposal');

  const body = await page.textContent('body');
  expect(body).toMatch(/expired/i);
  log('Expired status badge visible');
});

// ---------------------------------------------------------------------------
// 53. Transaction list tab counts are consistent
// ---------------------------------------------------------------------------

test('53. Transaction list tab counts match API', async () => { const page = sharedPage;
  log('=== Step 53: Tab count consistency ===');

  // Get counts from API
  const executed = await getProposals(contractAddress, 'executed');
  const pending = await getProposals(contractAddress, 'pending');
  const expired = await getProposals(contractAddress, 'expired');
  const invalidated = await getProposals(contractAddress, 'invalidated');
  log(`API counts: executed=${executed.length}, pending=${pending.length}, expired=${expired.length}, invalidated=${invalidated.length}`);

  await gotoWithWallet('/transactions', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Verify each tab shows the correct count
  const executedTab = page.locator('button', { hasText: /Executed/i }).first();
  const pendingTab = page.locator('button', { hasText: /Pending/i }).first();
  const expiredTab = page.locator('button', { hasText: /Expired/i }).first();
  const invalidatedTab = page.locator('button', { hasText: /Invalidated/i }).first();

  const executedText = await executedTab.textContent();
  const pendingText = await pendingTab.textContent();
  const expiredText = await expiredTab.textContent();
  const invalidatedText = await invalidatedTab.textContent();

  log(`Tab text: Executed="${executedText}", Pending="${pendingText}", Expired="${expiredText}", Invalidated="${invalidatedText}"`);

  expect(executedText).toContain(String(executed.length));
  expect(pendingText).toContain(String(pending.length));
  expect(expiredText).toContain(String(expired.length));
  expect(invalidatedText).toContain(String(invalidated.length));
  log('All tab counts match API');
});
