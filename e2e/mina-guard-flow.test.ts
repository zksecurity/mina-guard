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
  checkTxStatus,
  fundContract,
  getIndexerStatus,
  dumpState,
  type TestAccount,
} from './helpers';

// ---------------------------------------------------------------------------
// Shared state across sequential tests
// ---------------------------------------------------------------------------

let accounts: TestAccount[];
let contractAddress: string;
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
  sharedContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
  sharedPage = await sharedContext.newPage();

  // Capture browser console for diagnostics
  sharedPage.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('MultisigWorker') || text.includes('failed') || text.includes('Error')) {
      log(`[browser] ${text}`);
    }
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
  await gotoWithWallet('/deploy', accounts[0]);

  // Wait for the wallet to connect — the header should show the address
  await page.waitForFunction(
    (addr: string) => document.body.textContent?.includes(addr.slice(0, 6)),
    accounts[0].publicKey,
    { timeout: 30_000 }
  );
  log('Wallet connected');

  // Wait for keypair generation
  log('Waiting for keypair generation...');
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Generating keypair'),
    { timeout: 60_000 }
  );

  // Capture the generated contract address — find the element after the "Contract Address" label
  const addressEl = page
    .locator('text=Contract Address')
    .locator('..')
    .locator('.font-mono');
  await addressEl.waitFor({ state: 'visible', timeout: 10_000 });
  contractAddress = (await addressEl.textContent())?.trim() ?? '';
  expect(contractAddress).toMatch(/^B62/);
  log(`Contract address: ${contractAddress}`);

  // Click deploy
  log('Clicking Deploy...');
  const deployBtn = page.getByRole('button', { name: /deploy minaguard/i });
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
// 2. Setup contract (account1 as owner, threshold 1/1)
// ---------------------------------------------------------------------------

test('2. Setup contract (account1 as owner, threshold=1/1)', async () => { const page = sharedPage;
  log('=== Step 2: Setup contract ===');
  await gotoWithWallet('/', accounts[0]);

  // Select the deployed contract if needed
  // The dashboard might auto-select the only contract, or we may need to select it
  await page.waitForTimeout(3_000);

  // Click "Setup Contract" button
  log('Clicking Setup Contract...');
  const setupBtn = page.getByRole('button', { name: /setup contract/i });
  await setupBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await setupBtn.click();

  // Fill the setup modal
  log('Filling setup form...');

  // The first owner input should already be present
  const ownerInput = page.locator('input[placeholder*="Owner"]').first();
  await ownerInput.waitFor({ state: 'visible', timeout: 10_000 });
  await ownerInput.fill(accounts[0].publicKey);

  // Set threshold to 1
  const thresholdInput = page.locator('input[type="number"]').first();
  await thresholdInput.fill('1');

  // Set network ID (use "1" for testnet)
  const networkIdInput = page
    .locator('input')
    .filter({ hasText: /network/i })
    .or(page.locator('input').nth(2));
  // Try to find the network ID input — it might be the third input in the modal
  const inputs = page.locator('.fixed input, dialog input, [class*="modal"] input');
  const inputCount = await inputs.count();
  if (inputCount >= 3) {
    const lastInput = inputs.nth(inputCount - 1);
    const placeholder = await lastInput.getAttribute('placeholder');
    if (placeholder?.toLowerCase().includes('network') || inputCount >= 3) {
      await lastInput.fill('1');
    }
  }

  // Click "Run Setup"
  log('Clicking Run Setup...');
  const runSetupBtn = page.getByRole('button', { name: /run setup/i });
  await runSetupBtn.click();

  // Wait for operation to complete
  log('Waiting for setup transaction...');
  await waitForBanner(page, 'success');

  // Wait for indexer to pick up setup events
  await waitForIndexer(
    'indexer processes setup events',
    async () => {
      const owners = await getOwners(contractAddress);
      return owners.some(
        (o: any) => o.address === accounts[0].publicKey && o.active
      );
    }
  );

  // Verify contract state
  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(1);
  expect(contract.numOwners).toBe(1);
  log(`Setup verified: threshold=${contract.threshold}, numOwners=${contract.numOwners}`);

  // Verify owner
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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  // Click "New Proposal"
  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  // Select "Add Owner" type
  log('Selecting Add Owner type...');
  const addOwnerType = page.getByText('Add Owner').first();
  await addOwnerType.click();

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
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);

  // Wait for the ThresholdBadge to show numOwners=2 (useMultisig polls every 15s)
  log('Waiting for numOwners to update to 2...');
  await page.waitForFunction(
    () => {
      const spans = document.querySelectorAll('span');
      for (let i = 0; i < spans.length; i++) {
        if (spans[i].textContent?.trim() === '/' && spans[i + 1]?.textContent?.trim() === '2') {
          return true;
        }
      }
      return false;
    },
    { timeout: 30_000 }
  );

  // Open proposal modal from dashboard
  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  // Select "Change Threshold" type
  log('Selecting Change Threshold type...');
  const thresholdType = page.getByText('Change Threshold').first();
  await thresholdType.click();

  // Set new threshold to 2 (slider or input)
  const slider = page.locator('input[type="range"]');
  if ((await slider.count()) > 0) {
    await slider.first().fill('2');
  } else {
    const numInput = page.locator('input[type="number"]').first();
    await numInput.fill('2');
  }

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
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  // Open proposal modal from dashboard
  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  // Select "Send MINA" type
  log('Selecting Send MINA type...');
  const sendType = page.getByText('Send MINA').first();
  await sendType.click();

  // Fill recipient
  const recipientInput = page.locator('input[placeholder*="B62"]').first();
  await recipientInput.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientInput.fill(accounts[2].publicKey);

  // Fill amount (1 MINA — the contract is pre-funded with extra MINA in global setup)
  const amountInput = page.locator('input[placeholder*="0.0"]').first();
  await amountInput.fill('1');

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
  await page.waitForTimeout(3_000);

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
  await new Promise((r) => setTimeout(r, 30_000));

  // Navigate as account2
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[1]);
  await page.waitForTimeout(3_000);

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
    await new Promise((r) => setTimeout(r, 30_000));
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
  await page.waitForTimeout(3_000);

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
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  log('Selecting Change Threshold type...');
  // Click the "Change Threshold" type button. Use the button role with exact text
  // to avoid matching unrelated elements. The modal may have form fields from the
  // default "Send MINA" type overlapping, so click the type button directly.
  const typeButtons = page.locator('button[type="button"]');
  const count = await typeButtons.count();
  for (let i = 0; i < count; i++) {
    const text = await typeButtons.nth(i).textContent();
    if (text?.includes('Change Threshold')) {
      await typeButtons.nth(i).click({ force: true });
      break;
    }
  }
  await page.waitForTimeout(1_000);

  // Set threshold to 1 — the Change Threshold form shows a range slider
  const slider = page.locator('input[type="range"]');
  if ((await slider.count()) > 0) {
    await slider.first().fill('1');
  } else {
    // Fallback: try the large number display or any number input
    const numInput = page.locator('input[type="number"]').first();
    if ((await numInput.count()) > 0) {
      await numInput.fill('1');
    }
  }

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
  await page.waitForTimeout(3_000);

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
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  log('Selecting Remove Owner type...');
  const removeOwnerType = page.getByText('Remove Owner').first();
  await removeOwnerType.click();
  await page.waitForTimeout(500);

  // Select account2 from the owner list (radio button)
  // The remove owner form shows a list of current owners as selectable options
  const ownerOption = page.locator(`text=${accounts[1].publicKey.slice(0, 8)}`).first();
  if (await ownerOption.isVisible().catch(() => false)) {
    await ownerOption.click();
  } else {
    // Fallback: click the second radio/option in the list
    const options = page.locator('input[type="radio"]');
    if ((await options.count()) > 0) {
      await options.last().click();
    }
  }

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
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  log('Selecting Set Delegate type...');
  const typeButtons = page.locator('button[type="button"]');
  const count = await typeButtons.count();
  for (let i = 0; i < count; i++) {
    const text = await typeButtons.nth(i).textContent();
    if (text?.includes('Set Delegate')) {
      await typeButtons.nth(i).click({ force: true });
      break;
    }
  }
  await page.waitForTimeout(1_000);

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
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  log('Selecting Set Delegate type...');
  const typeButtons = page.locator('button[type="button"]');
  const count = await typeButtons.count();
  for (let i = 0; i < count; i++) {
    const text = await typeButtons.nth(i).textContent();
    if (text?.includes('Set Delegate')) {
      await typeButtons.nth(i).click({ force: true });
      break;
    }
  }
  await page.waitForTimeout(1_000);

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
  await page.waitForTimeout(3_000);

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
  const expiryBlock = currentHeight + 2; // expires in ~40s (20s slot time)
  log(`Current block height: ${currentHeight}, setting expiry: ${expiryBlock}`);

  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);

  log('Clicking New Proposal...');
  const newProposalBtn = page.getByRole('button', { name: /new proposal/i });
  await newProposalBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await newProposalBtn.click();
  await page.waitForTimeout(1_000);

  // Select "Send MINA"
  log('Selecting Send MINA type...');
  const sendType = page.getByText('Send MINA').first();
  await sendType.click();

  // Fill recipient (account3)
  const recipientInput = page.locator('input[placeholder*="B62"]').first();
  await recipientInput.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientInput.fill(accounts[2].publicKey);

  // Fill amount
  const amountInput = page.locator('input[placeholder*="0.0"]').first();
  await amountInput.fill('0.5');

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
    180_000, // 3 min — need to wait for blocks to pass the expiry
    5_000
  );

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('expired');
  log(`Proposal status: ${proposal.status}`);

  // Navigate to the proposal detail page
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[0]);
  await page.waitForTimeout(3_000);

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
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(3_000);
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  log('Delegate card visible on dashboard');

  // Settings — 1 owner
  await navigateTo(page, '/settings');
  await page.waitForTimeout(3_000);
  await expect(page.locator('text=Owners (1)')).toBeVisible({ timeout: 10_000 });
  log('Settings shows 1 owner');

  // Transactions — all proposals should be executed
  await navigateTo(page, '/transactions');
  await page.waitForTimeout(3_000);

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
