import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  log,
  loadState,
  setupTestPage,
  activateTestKey,
  switchAccount,
  navigateTo,
  waitForBanner,
  waitForIndexer,
  getContracts,
  getContract,
  getOwners,
  getProposals,
  getProposal,
  getApprovals,
  getChildren,
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

// ---------------------------------------------------------------------------
// Shared state across sequential tests
// ---------------------------------------------------------------------------

let accounts: TestAccount[];
let contractAddress: string;
let proposalHashes: string[] = [];
// Shared state for subaccount tests. Captured once from the wizard's
// "Contract Address" label on step 26 and reused by 27-28.
let childAddress: string = '';

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

// On failure, dump backend state for debugging
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed') {
    log(`TEST FAILED: ${testInfo.title}`);
    log(`Error: ${testInfo.error?.message}`);
    if (testInfo.error?.stack) {
      log(`Stack:\n${testInfo.error.stack}`);
    }
    await dumpState(contractAddress);
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

test('25. Verify final state', async () => { const page = sharedPage;
  log('=== Step 25: Verify final state ===');

  // Dashboard — delegate card should show contract self (undelegated)
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  log('Delegate card visible on dashboard');

  // Settings — 1 owner
  await navigateTo(page, '/settings');
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Owners (1)')).toBeVisible({ timeout: 10_000 });
  log('Settings shows 1 owner');

  // Transactions — all proposals should be executed
  await navigateTo(page, '/transactions');
  await page.waitForTimeout(SHORT_WAIT);

  const executedTab = page.locator('button', { hasText: /Executed/i }).first();
  const executedText = await executedTab.textContent();
  log(`Executed tab: ${executedText}`);
  expect(executedText).toContain('7'); // 5 original + delegate + undelegate

  const expiredTab = page.locator('button', { hasText: /Expired/i }).first();
  const expiredText = await expiredTab.textContent();
  log(`Expired tab: ${expiredText}`);
  expect(expiredText).toContain('1'); // the expiry test proposal

  const pendingTab = page.locator('button', { hasText: /Pending/i }).first();
  const pendingText = await pendingTab.textContent();
  log(`Pending tab: ${pendingText}`);
  expect(pendingText).toContain('0');

  // Final dump
  log('\n=== Final State ===');
  await dumpState(contractAddress);
  log('\n=== All 25 steps completed successfully! ===');
});

// ---------------------------------------------------------------------------
// 26. Propose CREATE_CHILD (subaccount) on parent
//
// By this point the parent has 1 owner (account1) at threshold 1/1, so the
// propose() auto-approve is immediately at threshold — no separate approval
// step is needed before finalizing.
// ---------------------------------------------------------------------------

test('26. Propose CREATE_CHILD on parent', async () => { const page = sharedPage;
  log('=== Step 26: Propose CREATE_CHILD ===');

  // Subaccount wizard: /accounts/new?parent=<parent> locks the network and
  // swaps "Deploy account" for "Propose subaccount".
  await gotoWithWallet(`/accounts/new?parent=${contractAddress}`, accounts[0]);

  // Wait for wallet
  await page.waitForFunction(
    (addr: string) => document.body.textContent?.includes(addr.slice(0, 6)),
    accounts[0].publicKey,
    { timeout: 30_000 }
  );

  // Step 1 → Step 2
  log('Advancing wizard to step 2...');
  await page.getByRole('button', { name: /^next$/i }).click();

  // Wait for the pre-generated keypair (step 2 mounts → auto-generate)
  log('Waiting for child keypair generation...');
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Generating keypair'),
    { timeout: 60_000 }
  );

  // Capture the new child address from the same locator pattern used by step 1
  const addressEl = page
    .getByText('Contract Address', { exact: true })
    .locator('xpath=following-sibling::p[1]');
  await addressEl.waitFor({ state: 'visible', timeout: 10_000 });
  childAddress = (await addressEl.textContent())?.trim() ?? '';
  expect(childAddress).toMatch(/^B62/);
  expect(childAddress).not.toBe(contractAddress);
  log(`Child address: ${childAddress}`);

  // Single-owner (account1) subaccount, threshold 1/1. Pre-filled by the
  // wizard to the connected wallet's address on mount, so threshold is all
  // that needs explicit input.
  log('Filling threshold...');
  await page.locator('input[type="number"]').first().fill('1');

  // Submit — this is "Propose subaccount" in subaccount mode
  log('Clicking Propose subaccount...');
  await page.getByRole('button', { name: /propose subaccount/i }).click();
  await waitForBanner(page, 'success');

  // Indexer picks up the CREATE_CHILD proposal on the parent
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
  expect(created.destination).toBe('remote');
  expect(created.approvalCount).toBe(1); // 1/1 threshold already met by proposer auto-approve
  proposalHashes.push(created.proposalHash);
  log(
    `CREATE_CHILD proposal: hash=${created.proposalHash.slice(0, 12)}..., approvals=${created.approvalCount}`
  );
});

// ---------------------------------------------------------------------------
// 27. Finalize subaccount deployment (executeSetupChild on the new child)
// ---------------------------------------------------------------------------

test('27. Finalize subaccount deployment', async () => { const page = sharedPage;
  log('=== Step 27: Finalize subaccount deployment ===');

  // The wizard redirects back to the parent detail page after propose. The
  // "Pending Subaccounts" banner shows a Finalize deployment button that
  // runs executeSetupChild.
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const finalizeBtn = page.getByRole('button', { name: /finalize deployment/i });
  await finalizeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  log('Clicking Finalize deployment...');
  await finalizeBtn.click();

  log('Waiting for executeSetupChild transaction...');
  await waitForBanner(page, 'success');

  // Indexer picks up the child's SetupEvent + the parent's CREATE_CHILD
  // execution (applyExecutionEvent walks child.parent on a local miss).
  await waitForIndexer(
    'indexer discovers child contract + marks parent proposal executed',
    async () => {
      const child = await getContract(childAddress);
      const parent = await getProposal(contractAddress, proposalHashes[proposalHashes.length - 1]);
      return child !== null && parent?.status === 'executed';
    },
    netConfig.mode === 'devnet' ? 2_400_000 : 180_000,
    netConfig.indexerPollIntervalMs
  );

  const child = await getContract(childAddress);
  expect(child.parent).toBe(contractAddress);
  expect(child.childMultiSigEnabled).toBe(true);
  expect(child.threshold).toBe(1);
  expect(child.numOwners).toBe(1);
  log(
    `Child contract indexed: parent=${child.parent.slice(0, 12)}..., multiSig=${child.childMultiSigEnabled}, threshold=${child.threshold}/${child.numOwners}`
  );

  const parentProposal = await getProposal(contractAddress, proposalHashes[proposalHashes.length - 1]);
  expect(parentProposal.status).toBe('executed');
  log(`Parent CREATE_CHILD proposal marked executed at block ${parentProposal.executedAtBlock}`);
});

// ---------------------------------------------------------------------------
// 28. Verify subaccount shows up in the UI tree + child detail page renders
// ---------------------------------------------------------------------------

test('28. Verify subaccount in UI tree', async () => { const page = sharedPage;
  log('=== Step 28: Verify subaccount in UI ===');

  // Root accounts list: the tree view should now show the parent with a
  // single indented subaccount underneath.
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const childRow = page.locator('a', {
    has: page.locator(`text=${childAddress.slice(0, 10)}`),
  });
  await expect(childRow).toBeVisible({ timeout: 15_000 });
  log('Child row visible in account tree');

  // Parent detail page: Subaccounts card should list the child.
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Subaccounts (1)')).toBeVisible({ timeout: 10_000 });
  log('Subaccounts (1) card visible on parent dashboard');

  // Child detail page renders with Parent card + multi-sig enabled state.
  await gotoWithWallet(`/accounts/${childAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Parent Account')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=Enabled').first()).toBeVisible({ timeout: 10_000 });
  log('Child detail renders with Parent card + multi-sig Enabled');
});

// ---------------------------------------------------------------------------
// TODO: Restore tests 29-32 (ALLOCATE_CHILD, RECLAIM_CHILD, DESTROY_CHILD
// final-state verification) once worker-recycling lands. The combined LOCAL +
// subaccount flow silently hangs `tx.prove()` around step 29; the 8 GB V8
// heap bump tripled runway but is not enough for the full chain. May need
// periodic page reload + persistent VK cache to work.
// ---------------------------------------------------------------------------
