/**
 * E2E test for the offchain batch-sig flow via the browser UI.
 *
 * Uses the same mock-wallet + shared-page pattern as onchain-flow.test.ts.
 * The key difference from the on-chain flow:
 *   - Propose: instant (API call, no proof)
 *   - Approve: instant (sign + API call, no proof)
 *   - Execute: on-chain batch transaction (compile + prove + send)
 *
 * Coverage:
 *   1.  Deploy + setup a MinaGuard contract (2 owners, threshold 2)
 *   2.  Transfer: propose (owner1) → approve (owner2) → execute → verify
 *   3.  Add owner (accounts[2]): propose → approve → execute → verify
 *   4.  Change threshold to 1: propose → approve → execute → verify
 *   5.  Remove owner (accounts[2]): propose (threshold=1) → execute → verify
 *   6.  Set delegate: propose → execute → verify dashboard
 *   7.  Undelegate: propose → execute → verify
 *   8.  Propose transfer with expiry → wait for expiry → verify expired UI
 *   9.  Verify Settings page
 *   10. Verify Transactions page filtering
 *   11. Verify final state
 */

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
  getContract,
  getOwners,
  getProposals,
  getProposal,
  getApprovals,
  getIndexerStatus,
  fundContract,
  dumpState,
  type TestAccount,
} from './helpers';
import { getNetworkConfig } from './network-config';

const netConfig = getNetworkConfig();
const SHORT_WAIT = netConfig.mode === 'devnet' ? 10_000 : 3_000;

// ---------------------------------------------------------------------------
// Shared state across sequential tests
// ---------------------------------------------------------------------------

let accounts: TestAccount[];
let contractAddress: string;
let proposalHashes: string[] = [];

let sharedPage: Page;
let sharedContext: BrowserContext;
let currentAccount: TestAccount | null = null;

test.beforeAll(async ({ browser }) => {
  const state = loadState();
  accounts = state.accounts;
  log(`Loaded ${accounts.length} test accounts`);
  accounts.forEach((a, i) => log(`  Account ${i + 1}: ${a.publicKey}`));

  sharedContext = await browser.newContext({ baseURL: netConfig.frontendUrl });
  sharedPage = await sharedContext.newPage();

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

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// Navigation helper (same pattern as onchain-flow)
// ---------------------------------------------------------------------------

async function gotoWithWallet(path: string, account: TestAccount): Promise<void> {
  const page = sharedPage;

  if (!currentAccount) {
    await setupTestPage(page, account);
    await page.goto(path, { waitUntil: 'networkidle' });
    await activateTestKey(page, account);
    currentAccount = account;
  } else {
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
  }

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

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed') {
    log(`TEST FAILED: ${testInfo.title}`);
    log(`Error: ${testInfo.error?.message}`);
    if (testInfo.error?.stack) log(`Stack:\n${testInfo.error.stack}`);
    await dumpState(contractAddress);
  }
});

// ---------------------------------------------------------------------------
// 1. Deploy + setup MinaGuard contract (2 owners, threshold=2)
// ---------------------------------------------------------------------------

test('1. Deploy + setup MinaGuard contract', async () => {
  const page = sharedPage;
  log('=== Step 1: Deploy + setup MinaGuard contract ===');
  await gotoWithWallet('/deploy', accounts[0]);

  await page.waitForFunction(
    (addr: string) => document.body.textContent?.includes(addr.slice(0, 6)),
    accounts[0].publicKey,
    { timeout: 30_000 }
  );
  log('Wallet connected');

  log('Waiting for keypair generation...');
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Generating keypair'),
    { timeout: 60_000 }
  );

  const addressEl = page.locator('p.break-all.font-mono');
  await addressEl.waitFor({ state: 'visible', timeout: 10_000 });
  contractAddress = (await addressEl.textContent())?.trim() ?? '';
  expect(contractAddress).toMatch(/^B62/);
  log(`Contract address: ${contractAddress}`);

  // The first owner field is pre-filled with the connected wallet address.
  // Add a second owner and set threshold to 2.
  log('Filling setup form on deploy page...');

  // Fill first owner (may be empty if wallet address wasn't available at render)
  const owner1Input = page.locator('input[placeholder*="Owner"]').first();
  await owner1Input.waitFor({ state: 'visible', timeout: 5_000 });
  await owner1Input.fill(accounts[0].publicKey);

  // Add second owner
  const addOwnerBtn = page.getByRole('button', { name: /add owner/i });
  await addOwnerBtn.click();

  // Wait for second owner input to appear
  const owner2Input = page.locator('input[placeholder*="Owner"]').nth(1);
  await owner2Input.waitFor({ state: 'visible', timeout: 5_000 });
  await owner2Input.fill(accounts[1].publicKey);

  const thresholdInput = page.locator('input[type="number"]').first();
  await thresholdInput.fill('2');

  log('Clicking Deploy MinaGuard...');
  const deployBtn = page.getByRole('button', { name: /deploy minaguard/i });
  await deployBtn.click();

  log('Waiting for deploy + setup transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer discovers deployed contract with setup', async () => {
    const contract = await getContract(contractAddress);
    return contract !== null && contract.threshold === 2 && contract.numOwners === 2;
  });

  const contract = await getContract(contractAddress);
  expect(contract).not.toBeNull();
  expect(contract.threshold).toBe(2);
  expect(contract.numOwners).toBe(2);
  log(`Contract deployed and set up: threshold=${contract.threshold}, numOwners=${contract.numOwners}`);

  const owners = await getOwners(contractAddress);
  const activeOwners = owners.filter((o: any) => o.active);
  expect(activeOwners).toHaveLength(2);
  log(`Owners verified: ${activeOwners.map((o: any) => o.address.slice(0, 12) + '...').join(', ')}`);

  await fundContract(contractAddress, accounts[0], 10);
});

// ---------------------------------------------------------------------------
// 2. Create offchain transfer proposal (owner1 proposes, auto-signs)
// ---------------------------------------------------------------------------

test('2. Create offchain transfer proposal', async () => {
  const page = sharedPage;
  log('=== Step 2: Create offchain transfer proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Send MINA proposal type...');
  await page.getByRole('link', { name: 'Send MINA', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Send MINA', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  log('Filling transfer form...');
  const recipientInput = page.locator('input[placeholder*="B62"]').first();
  await recipientInput.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientInput.fill(accounts[2].publicKey);

  const amountInput = page.locator('input[placeholder*="0"]').first();
  await amountInput.fill('1');

  log('Submitting offchain proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('offchain transfer proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((p: any) => p.txType === 'transfer');
  });

  const proposals = await getProposals(contractAddress, 'pending');
  const transferProposal = proposals.find((p: any) => p.txType === 'transfer');
  expect(transferProposal).toBeDefined();
  expect(transferProposal.approvalCount).toBe(1); // proposer auto-signed
  proposalHashes.push(transferProposal.proposalHash);
  log(`Transfer proposal created: hash=${proposalHashes[0].slice(0, 12)}..., approvals=${transferProposal.approvalCount}`);
});

// ---------------------------------------------------------------------------
// 3. Approve transfer with owner 2 (offchain)
// ---------------------------------------------------------------------------

test('3. Approve transfer with owner 2 (offchain)', async () => {
  const page = sharedPage;
  log('=== Step 3: Approve transfer with owner 2 ===');
  await gotoWithWallet(`/transactions/${proposalHashes[0]}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Approve Proposal...');
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();

  log('Waiting for approval banner...');
  await waitForBanner(page, 'success');

  await waitForIndexer('transfer approval count reaches threshold', async () => {
    const p = await getProposal(contractAddress, proposalHashes[0]);
    return p !== null && p.approvalCount >= 2;
  });

  const proposal = await getProposal(contractAddress, proposalHashes[0]);
  expect(proposal.approvalCount).toBe(2);
  log(`Approval count: ${proposal.approvalCount}/2 — ready for execution`);

  const approvals = await getApprovals(contractAddress, proposalHashes[0]);
  expect(approvals).toHaveLength(2);
  log(`Approvers: ${approvals.map((a: any) => a.approver.slice(0, 12) + '...').join(', ')}`);
});

// ---------------------------------------------------------------------------
// 4. Execute batch transfer
// ---------------------------------------------------------------------------

test('4. Execute batch transfer', async () => {
  const page = sharedPage;
  log('=== Step 4: Execute batch transfer ===');
  await gotoWithWallet(`/transactions/${proposalHashes[0]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for batch execute transaction (compile + prove + send)...');
  await waitForBanner(page, 'success');
  log('Batch execute transaction submitted');
});

// ---------------------------------------------------------------------------
// 5. Indexer reconciles transfer as executed
// ---------------------------------------------------------------------------

test('5. Indexer reconciles transfer as executed', async () => {
  log('=== Step 5: Verify indexer reconciliation of transfer ===');

  await waitForIndexer('indexer marks transfer as executed', async () => {
    const p = await getProposal(contractAddress, proposalHashes[0]);
    return p !== null && p.status === 'executed';
  });

  const proposal = await getProposal(contractAddress, proposalHashes[0]);
  expect(proposal).not.toBeNull();
  expect(proposal.status).toBe('executed');
  expect(proposal.origin).toBe('offchain');
  expect(proposal.executedAtBlock).not.toBeNull();
  log(`Transfer reconciled: status=${proposal.status}, executedAtBlock=${proposal.executedAtBlock}`);
});

// ---------------------------------------------------------------------------
// 6. Create offchain addOwner proposal (accounts[2])
// ---------------------------------------------------------------------------

test('6. Create offchain addOwner proposal', async () => {
  const page = sharedPage;
  log('=== Step 6: Create offchain addOwner proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Add Owner proposal type...');
  await page.getByRole('link', { name: 'Add Owner', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Add Owner', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  const ownerInput = page.locator('input[placeholder*="B62"]').first();
  await ownerInput.waitFor({ state: 'visible', timeout: 5_000 });
  await ownerInput.fill(accounts[2].publicKey);

  log('Submitting offchain addOwner proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('offchain addOwner proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((p: any) => p.txType === 'addOwner');
  });

  const proposals = await getProposals(contractAddress, 'pending');
  const addOwnerProposal = proposals.find((p: any) => p.txType === 'addOwner');
  expect(addOwnerProposal).toBeDefined();
  expect(addOwnerProposal.approvalCount).toBe(1); // proposer auto-signed
  proposalHashes.push(addOwnerProposal.proposalHash);
  log(`AddOwner proposal created: hash=${proposalHashes[1].slice(0, 12)}..., approvals=${addOwnerProposal.approvalCount}`);
});

// ---------------------------------------------------------------------------
// 7. Approve addOwner with owner 2
// ---------------------------------------------------------------------------

test('7. Approve addOwner with owner 2', async () => {
  const page = sharedPage;
  log('=== Step 7: Approve addOwner with owner 2 ===');
  await gotoWithWallet(`/transactions/${proposalHashes[1]}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Approve Proposal...');
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('addOwner approval count reaches threshold', async () => {
    const p = await getProposal(contractAddress, proposalHashes[1]);
    return p !== null && p.approvalCount >= 2;
  });

  const proposal = await getProposal(contractAddress, proposalHashes[1]);
  expect(proposal.approvalCount).toBe(2);
  log(`Approval count: ${proposal.approvalCount}/2 — ready for execution`);
});

// ---------------------------------------------------------------------------
// 8. Execute batch addOwner
// ---------------------------------------------------------------------------

test('8. Execute batch addOwner', async () => {
  const page = sharedPage;
  log('=== Step 8: Execute batch addOwner ===');
  await gotoWithWallet(`/transactions/${proposalHashes[1]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for batch addOwner transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer marks addOwner as executed', async () => {
    const p = await getProposal(contractAddress, proposalHashes[1]);
    return p !== null && p.status === 'executed';
  });

  await waitForIndexer('indexer updates owner list to 3', async () => {
    const owners = await getOwners(contractAddress);
    return owners.filter((o: any) => o.active).length === 3;
  });

  const owners = await getOwners(contractAddress);
  const activeOwners = owners.filter((o: any) => o.active);
  expect(activeOwners).toHaveLength(3);
  expect(activeOwners.some((o: any) => o.address === accounts[2].publicKey)).toBe(true);
  log(`Owners after addOwner: ${activeOwners.map((o: any) => o.address.slice(0, 12) + '...').join(', ')}`);
});

// ---------------------------------------------------------------------------
// 9. Create offchain changeThreshold proposal (2 → 1)
// ---------------------------------------------------------------------------

test('9. Create offchain changeThreshold proposal (threshold=1)', async () => {
  const page = sharedPage;
  log('=== Step 9: Create offchain changeThreshold proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Change Threshold proposal type...');
  await page.getByRole('link', { name: 'Change Threshold', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Change Threshold', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  const slider = page.locator('input[type="range"]');
  if ((await slider.count()) > 0) {
    await slider.first().fill('1');
  }

  log('Submitting changeThreshold proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('offchain changeThreshold proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((p: any) => p.txType === 'changeThreshold');
  });

  const proposals = await getProposals(contractAddress, 'pending');
  const thresholdProposal = proposals.find((p: any) => p.txType === 'changeThreshold');
  expect(thresholdProposal).toBeDefined();
  expect(thresholdProposal.approvalCount).toBe(1);
  proposalHashes.push(thresholdProposal.proposalHash);
  log(`ChangeThreshold proposal created: hash=${proposalHashes[2].slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 10. Approve changeThreshold with owner 2
// ---------------------------------------------------------------------------

test('10. Approve changeThreshold with owner 2', async () => {
  const page = sharedPage;
  log('=== Step 10: Approve changeThreshold with owner 2 ===');
  await gotoWithWallet(`/transactions/${proposalHashes[2]}`, accounts[1]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Approve Proposal...');
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('changeThreshold approval count reaches threshold', async () => {
    const p = await getProposal(contractAddress, proposalHashes[2]);
    return p !== null && p.approvalCount >= 2;
  });

  const proposal = await getProposal(contractAddress, proposalHashes[2]);
  expect(proposal.approvalCount).toBe(2);
  log(`Approval count: ${proposal.approvalCount}/2 — ready for execution`);
});

// ---------------------------------------------------------------------------
// 11. Execute batch changeThreshold
// ---------------------------------------------------------------------------

test('11. Execute batch changeThreshold', async () => {
  const page = sharedPage;
  log('=== Step 11: Execute batch changeThreshold ===');
  await gotoWithWallet(`/transactions/${proposalHashes[2]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for batch changeThreshold transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer marks changeThreshold as executed', async () => {
    const p = await getProposal(contractAddress, proposalHashes[2]);
    return p !== null && p.status === 'executed';
  });

  await waitForIndexer('indexer updates threshold to 1', async () => {
    const contract = await getContract(contractAddress);
    return contract?.threshold === 1;
  });

  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(1);
  log(`Threshold updated: ${contract.threshold}/${contract.numOwners}`);
});

// ---------------------------------------------------------------------------
// 12. Create offchain removeOwner proposal (accounts[2], threshold=1)
// ---------------------------------------------------------------------------

test('12. Create offchain removeOwner proposal', async () => {
  const page = sharedPage;
  log('=== Step 12: Create offchain removeOwner proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Remove Owner proposal type...');
  await page.getByRole('link', { name: 'Remove Owner', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Remove Owner', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  // Select accounts[2] from the owner list (radio button)
  const ownerOption = page.locator(`text=${accounts[2].publicKey.slice(0, 8)}`).first();
  if (await ownerOption.isVisible().catch(() => false)) {
    await ownerOption.click();
  } else {
    const options = page.locator('input[type="radio"]');
    if ((await options.count()) > 0) {
      await options.last().click();
    }
  }

  log('Submitting removeOwner proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('offchain removeOwner proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((p: any) => p.txType === 'removeOwner');
  });

  const proposals = await getProposals(contractAddress, 'pending');
  const removeProposal = proposals.find((p: any) => p.txType === 'removeOwner');
  expect(removeProposal).toBeDefined();
  expect(removeProposal.approvalCount).toBe(1); // threshold=1, proposer auto-signed
  proposalHashes.push(removeProposal.proposalHash);
  log(`RemoveOwner proposal created: hash=${proposalHashes[3].slice(0, 12)}..., approvals=${removeProposal.approvalCount}`);
});

// ---------------------------------------------------------------------------
// 13. Execute batch removeOwner
// ---------------------------------------------------------------------------

test('13. Execute batch removeOwner', async () => {
  const page = sharedPage;
  log('=== Step 13: Execute batch removeOwner ===');
  await gotoWithWallet(`/transactions/${proposalHashes[3]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for batch removeOwner transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer marks removeOwner as executed', async () => {
    const p = await getProposal(contractAddress, proposalHashes[3]);
    return p !== null && p.status === 'executed';
  });

  await waitForIndexer('indexer updates owner list after removal', async () => {
    const owners = await getOwners(contractAddress);
    const active = owners.filter((o: any) => o.active);
    return active.length === 2 && !active.some((o: any) => o.address === accounts[2].publicKey);
  });

  const owners = await getOwners(contractAddress);
  const activeOwners = owners.filter((o: any) => o.active);
  expect(activeOwners).toHaveLength(2);
  expect(activeOwners.some((o: any) => o.address === accounts[2].publicKey)).toBe(false);
  log(`Owner removed. Active owners: ${activeOwners.map((o: any) => o.address.slice(0, 12) + '...').join(', ')}`);

  const contract = await getContract(contractAddress);
  expect(contract.numOwners).toBe(2);
  log(`Contract state: threshold=${contract.threshold}, numOwners=${contract.numOwners}`);
});

// ---------------------------------------------------------------------------
// 14. Verify Settings page
// ---------------------------------------------------------------------------

test('14. Verify Settings page', async () => {
  const page = sharedPage;
  log('=== Step 14: Verify Settings page ===');
  await gotoWithWallet('/settings', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  await expect(page.locator('text=Required Confirmations')).toBeVisible({ timeout: 10_000 });
  log('Required Confirmations section visible');

  await expect(page.locator('text=Owners (2)')).toBeVisible({ timeout: 10_000 });
  log('Owners count shows 2');

  await expect(page.locator('text=Config Nonce')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=Owners Commitment')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=Network ID')).toBeVisible({ timeout: 10_000 });
  log('Contract info section verified');
});

// ---------------------------------------------------------------------------
// 15. Create offchain setDelegate proposal
// ---------------------------------------------------------------------------

test('15. Create offchain setDelegate proposal', async () => {
  const page = sharedPage;
  log('=== Step 15: Create offchain setDelegate proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Verify delegate card shows None initially
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=None')).toBeVisible({ timeout: 10_000 });
  log('Delegate card shows None');

  log('Clicking Set Delegate proposal type...');
  await page.getByRole('link', { name: 'Set Delegate', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Set Delegate', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  const delegateInput = page.locator('input[placeholder*="B62"]').first();
  await delegateInput.waitFor({ state: 'visible', timeout: 5_000 });
  await delegateInput.fill(accounts[2].publicKey);

  log('Submitting setDelegate proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('offchain setDelegate proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((p: any) => p.txType === 'setDelegate');
  });

  const proposals = await getProposals(contractAddress, 'pending');
  const delegateProposal = proposals.find((p: any) => p.txType === 'setDelegate');
  expect(delegateProposal).toBeDefined();
  expect(delegateProposal.approvalCount).toBe(1); // threshold=1
  proposalHashes.push(delegateProposal.proposalHash);
  log(`SetDelegate proposal created: hash=${proposalHashes[4].slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 16. Execute batch setDelegate
// ---------------------------------------------------------------------------

test('16. Execute batch setDelegate', async () => {
  const page = sharedPage;
  log('=== Step 16: Execute batch setDelegate ===');
  await gotoWithWallet(`/transactions/${proposalHashes[4]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for batch setDelegate transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer marks setDelegate as executed', async () => {
    const p = await getProposal(contractAddress, proposalHashes[4]);
    return p !== null && p.status === 'executed';
  });

  await waitForIndexer('indexer updates delegate field', async () => {
    const contract = await getContract(contractAddress);
    return contract?.delegate != null && contract.delegate.length > 10;
  });

  const contract = await getContract(contractAddress);
  log(`Delegate set to: ${contract.delegate}`);
});

// ---------------------------------------------------------------------------
// 17. Verify dashboard shows delegate address
// ---------------------------------------------------------------------------

test('17. Verify dashboard shows delegate address', async () => {
  const page = sharedPage;
  log('=== Step 17: Verify delegate card on dashboard ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  const delegateText = page.locator(`text=${accounts[2].publicKey.slice(0, 8)}`);
  await expect(delegateText.first()).toBeVisible({ timeout: 10_000 });
  log('Dashboard shows delegate address');
});

// ---------------------------------------------------------------------------
// 18. Create offchain undelegate proposal
// ---------------------------------------------------------------------------

test('18. Create offchain undelegate proposal', async () => {
  const page = sharedPage;
  log('=== Step 18: Create offchain undelegate proposal ===');
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Set Delegate proposal type...');
  await page.getByRole('link', { name: 'Set Delegate', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Set Delegate', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  log('Checking Undelegate checkbox...');
  const undelegateCheckbox = page.locator('input[type="checkbox"]').first();
  await undelegateCheckbox.waitFor({ state: 'visible', timeout: 5_000 });
  await undelegateCheckbox.check();

  log('Submitting undelegate proposal...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  // Find the pending setDelegate (the undelegate one — setDelegate is executed)
  await waitForIndexer('offchain undelegate proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress, 'pending');
    return proposals.some((p: any) => p.txType === 'setDelegate');
  });

  const proposals = await getProposals(contractAddress, 'pending');
  const undelegateProposal = proposals.find((p: any) => p.txType === 'setDelegate');
  expect(undelegateProposal).toBeDefined();
  proposalHashes.push(undelegateProposal.proposalHash);
  log(`Undelegate proposal created: hash=${proposalHashes[5].slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 19. Execute batch undelegate
// ---------------------------------------------------------------------------

test('19. Execute batch undelegate', async () => {
  const page = sharedPage;
  log('=== Step 19: Execute batch undelegate ===');
  await gotoWithWallet(`/transactions/${proposalHashes[5]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Execute Proposal...');
  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await executeBtn.click();

  log('Waiting for batch undelegate transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer marks undelegate as executed', async () => {
    const p = await getProposal(contractAddress, proposalHashes[5]);
    return p !== null && p.status === 'executed';
  });

  await waitForIndexer('indexer updates delegate after undelegate', async () => {
    const contract = await getContract(contractAddress);
    return contract?.delegate === contractAddress;
  });

  const contract = await getContract(contractAddress);
  log(`Delegate after undelegate: ${contract.delegate}`);
});

// ---------------------------------------------------------------------------
// 20. Propose transfer with near-future expiry
// ---------------------------------------------------------------------------

test('20. Propose transfer with near-future expiry', async () => {
  const page = sharedPage;
  log('=== Step 20: Propose transfer with expiry ===');

  const status = await getIndexerStatus();
  const currentHeight = status?.latestChainHeight ?? status?.indexedHeight ?? 0;
  const expiryBlock = currentHeight + netConfig.expiryBlockOffset;
  log(`Current block height: ${currentHeight}, setting expiry: ${expiryBlock}`);

  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Send MINA proposal type...');
  await page.getByRole('link', { name: 'Send MINA', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('link', { name: 'Send MINA', exact: true }).click();
  await page.waitForURL(/transactions\/new/);

  const recipientInput = page.locator('input[placeholder*="B62"]').first();
  await recipientInput.waitFor({ state: 'visible', timeout: 5_000 });
  await recipientInput.fill(accounts[2].publicKey);

  const amountInput = page.locator('input[placeholder*="0.0"]').first();
  await amountInput.fill('0.5');

  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill(String(expiryBlock));
  }

  log('Submitting proposal with expiry...');
  const submitBtn = page.getByRole('button', { name: /submit proposal/i });
  await submitBtn.click();

  await waitForBanner(page, 'success');

  await waitForIndexer('expiring transfer proposal appears in backend', async () => {
    const proposals = await getProposals(contractAddress);
    return proposals.some(
      (p: any) => p.txType === 'transfer' && p.expiryBlock === String(expiryBlock)
    );
  });

  const proposals = await getProposals(contractAddress);
  const expiringProposal = proposals.find(
    (p: any) => p.txType === 'transfer' && p.expiryBlock === String(expiryBlock)
  );
  expect(expiringProposal).toBeDefined();
  proposalHashes.push(expiringProposal.proposalHash);
  log(`Expiring proposal created: hash=${proposalHashes[6].slice(0, 12)}..., expiryBlock=${expiryBlock}`);
});

// ---------------------------------------------------------------------------
// 21. Verify proposal expires and execute button is hidden
// ---------------------------------------------------------------------------

test('21. Verify proposal expires and execute button is hidden', async () => {
  const page = sharedPage;
  log('=== Step 21: Verify proposal expiry ===');

  log('Waiting for proposal to expire...');
  await waitForIndexer(
    'indexer marks proposal as expired',
    async () => {
      const proposal = await getProposal(contractAddress, proposalHashes[6]);
      return proposal?.status === 'expired';
    },
    netConfig.mode === 'devnet' ? 2_400_000 : 180_000,
    netConfig.indexerPollIntervalMs
  );

  const proposal = await getProposal(contractAddress, proposalHashes[6]);
  expect(proposal.status).toBe('expired');
  log(`Proposal status: ${proposal.status}`);

  await gotoWithWallet(`/transactions/${proposalHashes[6]}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const expiredBadge = page.locator('text=expired').or(page.locator('text=Expired'));
  await expect(expiredBadge.first()).toBeVisible({ timeout: 10_000 });
  log('Status badge shows Expired');

  const executeBtn = page.getByRole('button', { name: /execute proposal/i });
  await expect(executeBtn).not.toBeVisible({ timeout: 5_000 });
  log('Execute button is hidden for expired proposal');

  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await expect(approveBtn).not.toBeVisible({ timeout: 5_000 });
  log('Approve button is hidden for expired proposal');
});

// ---------------------------------------------------------------------------
// 22. Verify Transactions page filtering
// ---------------------------------------------------------------------------

test('22. Verify Transactions page filtering', async () => {
  const page = sharedPage;
  log('=== Step 22: Verify Transactions page filtering ===');
  await gotoWithWallet('/transactions', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // After all steps: 6 executed (transfer, addOwner, changeThreshold, removeOwner, setDelegate, undelegate)
  // + 1 expired = 7 total proposals
  const allTab = page.locator('button', { hasText: /All/i }).first();
  await expect(allTab).toBeVisible({ timeout: 10_000 });
  const allText = await allTab.textContent();
  log(`All tab: ${allText}`);
  expect(allText).toContain('7');

  const executedTab = page.locator('button', { hasText: /Executed/i }).first();
  await executedTab.click();
  await page.waitForTimeout(1_000);
  const executedText = await executedTab.textContent();
  log(`Executed tab: ${executedText}`);
  expect(executedText).toContain('6');

  const expiredTab = page.locator('button', { hasText: /Expired/i }).first();
  const expiredText = await expiredTab.textContent();
  log(`Expired tab: ${expiredText}`);
  expect(expiredText).toContain('1');

  const pendingTab = page.locator('button', { hasText: /Pending/i }).first();
  const pendingText = await pendingTab.textContent();
  log(`Pending tab: ${pendingText}`);
  expect(pendingText).toContain('0');

  log('Transaction filtering verified');
});

// ---------------------------------------------------------------------------
// 23. Verify final state
// ---------------------------------------------------------------------------

test('23. Verify final state', async () => {
  const page = sharedPage;
  log('=== Step 23: Verify final state ===');

  // Dashboard — delegate card should show contract self (undelegated)
  await gotoWithWallet('/', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 10_000 });
  log('Delegate card visible on dashboard');

  // Settings — 2 owners (accounts[0] and accounts[1]), threshold=1
  await navigateTo(page, '/settings');
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Owners (2)')).toBeVisible({ timeout: 10_000 });
  log('Settings shows 2 owners');

  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(1);
  expect(contract.numOwners).toBe(2);
  log(`Final contract state: threshold=${contract.threshold}, numOwners=${contract.numOwners}`);

  log('\n=== Final State ===');
  await dumpState(contractAddress);
  log('\n=== All 23 steps completed successfully! ===');
});
