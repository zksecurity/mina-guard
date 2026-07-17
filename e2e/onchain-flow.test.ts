/**
 * Chain e2e — the GOLDEN PATH only: one full pass through every structurally
 * distinct piece of plumbing against a real chain (lightnet/devnet):
 *
 *   deploy → create subvault → delete-proposal flow (single-sig phase)
 *   → add owner → raise threshold (governance)
 *   → transfer with memo: propose / approve / execute (multi-sig phase)
 *
 * Everything else this suite used to cover lives in faster tiers:
 *   - circuit logic per tx type ................ contracts/src/tests/
 *   - indexer event decoding per type .......... backend/src/tests/indexer-event-decode.test.ts
 *   - status/memo derivation ................... backend/src/tests/proposal-record.test.ts
 *   - form payloads + validation ............... e2e/ui/forms.test.ts (capture hook)
 *   - display/state rendering .................. e2e/ui/display.test.ts, smoke.test.ts
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  log,
  loadState,
  setupTestPage,
  activateTestKey,
  switchAccount,
  navigateTo,
  waitForBanner as _waitForBanner,
  fillRecipients,
  waitForIndexer,
  getIndexerStatus,
  getContracts,
  getContract,
  getOwners,
  getProposals,
  getProposal,
  getApprovals,
  checkTxStatus,
  fundContract,
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
// Proposal-flow helpers — every proposal walks the same propose / approve /
// execute UI, so each test only supplies what differs (form fill + predicate).
// ---------------------------------------------------------------------------

/** Fills the expiry input with the given slot value (0 = no expiry), if present. */
async function setExpiry(value: string | number = 0): Promise<void> {
  const expiryInput = sharedPage.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill(String(value));
  }
}

/** Clicks the submit button and waits for the success banner. */
async function submitAndAwaitBanner(name: RegExp = /submit proposal/i): Promise<string> {
  log('Submitting proposal...');
  await sharedPage.getByRole('button', { name }).click();
  log('Waiting for propose transaction...');
  return waitForBanner(sharedPage, 'success');
}

/** Fills the first B62-placeholder address input on the page. */
async function fillFirstB62Input(value: string): Promise<void> {
  const input = sharedPage.locator('input[placeholder*="B62"]').first();
  await input.waitFor({ state: 'visible', timeout: 5_000 });
  await input.fill(value);
}

interface ProposeOptions {
  /** ?type= value for /transactions/new */
  type: string;
  /** Form-specific filling, runs after navigation and before expiry/submit */
  fill?: () => Promise<void>;
  /** Expiry slot (default 0 = no expiry) */
  expiry?: string | number;
  /** Predicate identifying the new proposal in the list */
  match: (p: any) => boolean;
  /** Query all proposals instead of status=pending */
  anyStatus?: boolean;
  /** waitForIndexer description */
  waitDescription: string;
  account?: TestAccount;
}

/**
 * Drives /transactions/new for one proposal: navigate, fill, submit, wait for
 * the indexer to pick it up. Pushes the hash onto proposalHashes and returns
 * the indexed proposal.
 */
async function proposeViaForm(opts: ProposeOptions): Promise<any> {
  const page = sharedPage;
  await gotoWithWallet(`/transactions/new?type=${opts.type}`, opts.account ?? accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  await opts.fill?.();
  await setExpiry(opts.expiry ?? 0);
  await submitAndAwaitBanner();

  const status = opts.anyStatus ? undefined : 'pending';
  await waitForIndexer(opts.waitDescription, async () => {
    const proposals = await getProposals(contractAddress, status);
    return proposals.some(opts.match);
  });

  const proposal = (await getProposals(contractAddress, status)).find(opts.match);
  expect(proposal).toBeDefined();
  proposalHashes.push(proposal.proposalHash);
  log(`Proposal created: type=${proposal.txType}, hash=${proposal.proposalHash.slice(0, 12)}..., approvals=${proposal.approvalCount}`);
  return proposal;
}

interface ExecuteOptions {
  account?: TestAccount;
  /** Extra query string appended to the detail URL (e.g. `?account=...`) */
  query?: string;
  /** waitForIndexer description */
  waitDescription: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Overrides the default status === 'executed' indexer check */
  until?: () => Promise<boolean>;
  /** Runs after the success banner, before the indexer wait (diagnostics) */
  onBanner?: (bannerText: string) => Promise<void>;
}

/**
 * Best-effort barrier: wait until the backend indexer has caught up to the
 * chain tip so any state the worker rebuilds from the backend reflects the
 * latest blocks. Non-fatal — if the indexer can't catch up in time we proceed
 * anyway rather than failing the test on the barrier itself.
 */
async function waitForIndexerCaughtUp(timeoutMs = 45_000): Promise<void> {
  try {
    await waitForIndexer(
      'indexer caught up to chain tip',
      async () => {
        const s = await getIndexerStatus();
        return !!s && s.latestChainHeight > 0 && s.indexedHeight >= s.latestChainHeight;
      },
      timeoutMs,
    );
  } catch {
    log('  (indexer not fully caught up — proceeding anyway)');
  }
}

/**
 * Opens a proposal's detail page, clicks Execute, waits for the success banner
 * and then for the indexer to reflect the execution. Returns the banner text.
 *
 * Retries the whole submit. A zkApp execute tx that the daemon accepts into the
 * pool can still be silently lost under load — the tip drifts (fee-payer nonce
 * or a state precondition) between acceptance and inclusion, so it never mines
 * and the single-shot wait would burn the full timeout. Each attempt first lets
 * the indexer settle, re-checks whether a prior attempt's tx landed late, then
 * re-submits against freshly-settled state with a shorter per-attempt wait.
 */
async function executeProposal(proposalHash: string, opts: ExecuteOptions): Promise<string> {
  const page = sharedPage;
  const isExecuted = opts.until ?? (async () => {
    const proposal = await getProposal(contractAddress, proposalHash);
    return proposal?.status === 'executed';
  });

  const maxAttempts = 3;
  const perAttemptMs = Math.min(opts.timeoutMs ?? 240_000, 70_000);
  let bannerText = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForIndexerCaughtUp();
    await gotoWithWallet(`/transactions/${proposalHash}${opts.query ?? ''}`, opts.account ?? accounts[0]);
    await page.waitForTimeout(SHORT_WAIT);

    // A previous attempt's tx may have landed late while we were retrying.
    if (await isExecuted()) {
      log(`Proposal already executed (attempt ${attempt}) — done`);
      return bannerText || '(already executed)';
    }

    log(`Clicking Execute Proposal... (attempt ${attempt}/${maxAttempts})`);
    const executeBtn = page.getByRole('button', { name: /execute proposal/i });
    await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await executeBtn.click();

    log('Waiting for execute transaction...');
    bannerText = await waitForBanner(page, 'success');
    await opts.onBanner?.(bannerText);

    try {
      await waitForIndexer(opts.waitDescription, isExecuted, perAttemptMs, opts.intervalMs);
      return bannerText;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      log(`  Execute not confirmed in ${(perAttemptMs / 1000).toFixed(0)}s — re-submitting (attempt ${attempt + 1}/${maxAttempts})`);
    }
  }
  return bannerText;
}

/** Opens a proposal's detail page as `account`, clicks Approve, waits for the count. */
async function approveProposal(
  proposalHash: string,
  account: TestAccount,
  expectedCount: number
): Promise<void> {
  const page = sharedPage;
  await gotoWithWallet(`/transactions/${proposalHash}`, account);
  await page.waitForTimeout(SHORT_WAIT);

  log('Clicking Approve Proposal...');
  const approveBtn = page.getByRole('button', { name: /approve proposal/i });
  await approveBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await approveBtn.click();

  log('Waiting for approve transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer('indexer processes approval', async () => {
    const proposal = await getProposal(contractAddress, proposalHash);
    return proposal?.approvalCount >= expectedCount;
  });

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.approvalCount).toBe(expectedCount);
  log(`Approval count: ${proposal.approvalCount}/${expectedCount} (threshold met)`);
}

/** Asserts a transactions-page tab's text contains the expected count. */
async function expectTabCount(label: RegExp, count: number | string): Promise<void> {
  const tab = sharedPage.locator('button', { hasText: label }).first();
  const text = await tab.textContent();
  log(`${label} tab: ${text}`);
  expect(text).toContain(String(count));
}

// ---------------------------------------------------------------------------
// 1. Deploy MinaGuard contract (single owner, threshold 1)
// ---------------------------------------------------------------------------

test('1. Deploy MinaGuard contract', async () => { const page = sharedPage;
  log('=== Step 1: Deploy MinaGuard contract ===');
  // "+ Create account" on `/` routes to the 2-step wizard at `/accounts/new`.
  // Step 1 is name + network, step 2 is owners + threshold + keypair + deploy.
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

  log('Clicking Deploy account...');
  await page.getByRole('button', { name: /deploy vault/i }).click();

  log('Waiting for deploy transaction...');
  await waitForBanner(page, 'success');

  await waitForIndexer(
    'indexer discovers deployed contract',
    async () => {
      const contracts = await getContracts();
      return contracts.some((c: any) => c.address === contractAddress);
    }
  );

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

// ===========================================================================
// SINGLE-SIG PHASE (threshold 1/1): subvault creation + delete-proposal flow
// ===========================================================================

// ---------------------------------------------------------------------------
// 3. Propose CREATE_CHILD (subvault) on parent
// ---------------------------------------------------------------------------

test('3. Propose CREATE_CHILD on parent', async () => { const page = sharedPage;
  log('=== Step 3: Propose CREATE_CHILD ===');

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
  await page.getByRole('button', { name: /propose subvault/i }).click();
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
// 4. Execute CREATE_CHILD (executeSetupChild on the deployed child)
// ---------------------------------------------------------------------------

test('4. Execute CREATE_CHILD via proposal detail', async () => {
  log('=== Step 4: Execute CREATE_CHILD ===');
  const createChildHash = proposalHashes[proposalHashes.length - 1];

  await executeProposal(createChildHash, {
    query: `?account=${contractAddress}`,
    waitDescription: 'indexer discovers child contract + marks parent proposal executed',
    timeoutMs: 180_000,
    intervalMs: netConfig.indexerPollIntervalMs,
    until: async () => {
      const child = await getContract(childAddress);
      const parent = await getProposal(contractAddress, createChildHash);
      return child !== null && parent?.status === 'executed';
    },
  });

  const child = await getContract(childAddress);
  expect(child.parent).toBe(contractAddress);
  expect(child.childMultiSigEnabled).toBe(true);
  expect(child.threshold).toBe(1);
  expect(child.numOwners).toBe(1);
  log(`Child contract indexed: parent=${child.parent.slice(0, 12)}..., threshold=${child.threshold}/${child.numOwners}`);

  const parentProposal = await getProposal(contractAddress, createChildHash);
  expect(parentProposal.status).toBe('executed');
  log(`Parent CREATE_CHILD proposal marked executed`);
});

// ---------------------------------------------------------------------------
// 4b. ALLOCATE_CHILD (parent → child) — golden-path exercise of
//     executeChildLifecycleOnchain. Every other child-lifecycle branch
//     (reclaim/destroy/toggle) is covered by contracts/src/tests/ (circuit)
//     + backend indexer-event-decode (decode) + e2e/ui/forms (payload
//     shape). This one on-chain execution keeps the worker's tx-type
//     routing honest against future refactors of the branching logic.
// ---------------------------------------------------------------------------

test('4b. ALLOCATE_CHILD from parent to subvault (executeChildLifecycleOnchain)', async () => { const page = sharedPage;
  log('=== Step 4b: Propose + execute ALLOCATE_CHILD ===');

  // Parent may still be active from test 4, but reassert to be safe — the
  // proposal form derives its nonce space from the active contract.
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  const proposal = await proposeViaForm({
    type: 'allocateChild',
    fill: () => fillRecipients(page, `${childAddress},1`),
    match: (p: any) =>
      p.txType === 'allocateChild' && p.receivers?.some((r: any) => r.address === childAddress),
    waitDescription: 'indexer processes ALLOCATE_CHILD proposal',
  });
  const allocateHash = proposal.proposalHash;
  log(`ALLOCATE_CHILD proposal: hash=${allocateHash.slice(0, 12)}...`);

  await executeProposal(allocateHash, {
    waitDescription: 'indexer processes ALLOCATE_CHILD execution',
  });

  const executed = await getProposal(contractAddress, allocateHash);
  expect(executed.status).toBe('executed');
  log(`ALLOCATE_CHILD executed`);
});

// ---------------------------------------------------------------------------
// 5. Propose a transfer, then create a delete proposal for it
// ---------------------------------------------------------------------------

test('5. Propose transfer then delete it', async () => { const page = sharedPage;
  log('=== Step 5: Propose transfer + delete ===');

  // Ensure parent is the active contract (step 4 may have left the child active)
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // First, create a normal transfer proposal
  const targetProposal = await proposeViaForm({
    type: 'transfer',
    fill: () => fillRecipients(page, `${accounts[2].publicKey},0.1`),
    match: (p) => p.txType === 'transfer',
    waitDescription: 'indexer processes transfer proposal (to be deleted)',
  });
  const targetHash = targetProposal.proposalHash;
  log(`Target proposal: hash=${targetHash.slice(0, 12)}..., nonce=${targetProposal.nonce}`);

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
  const deleteSubmitBtn = page.getByRole('button', { name: /create delete proposal/i });
  await deleteSubmitBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await submitAndAwaitBanner(/create delete proposal/i);

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
// 6. Execute delete proposal and verify invalidation
// ---------------------------------------------------------------------------

test('6. Execute delete proposal and verify invalidation', async () => { const page = sharedPage;
  log('=== Step 6: Execute delete proposal ===');
  const deleteProposalHash = proposalHashes[proposalHashes.length - 1];
  const targetProposalHash = proposalHashes[proposalHashes.length - 2];

  await executeProposal(deleteProposalHash, {
    waitDescription: 'indexer processes delete execution + marks target invalidated',
    timeoutMs: 360_000,
    intervalMs: 10_000,
    until: async () => {
      const deleteP = await getProposal(contractAddress, deleteProposalHash);
      const targetP = await getProposal(contractAddress, targetProposalHash);
      return deleteP?.status === 'executed' && targetP?.status === 'invalidated';
    },
  });

  const deleteP = await getProposal(contractAddress, deleteProposalHash);
  expect(deleteP.status).toBe('executed');
  log(`Delete proposal executed`);

  const targetP = await getProposal(contractAddress, targetProposalHash);
  expect(targetP.status).toBe('invalidated');
  log(`Target proposal invalidated`);

  // Verify Invalidated tab on transactions page
  await navigateTo(page, '/transactions');
  await page.waitForTimeout(SHORT_WAIT);
  await expectTabCount(/Invalidated/i, 1);
});

// ===========================================================================
// GOVERNANCE PHASE: add a second owner and raise the threshold to 2/2
// ===========================================================================

// ---------------------------------------------------------------------------
// 7. Propose: add account2 as new owner
// ---------------------------------------------------------------------------

test('7. Propose add owner (account2)', async () => {
  log('=== Step 7: Propose add owner ===');
  const proposal = await proposeViaForm({
    type: 'addOwner',
    fill: () => fillFirstB62Input(accounts[1].publicKey),
    match: (p) => p.txType === 'addOwner',
    waitDescription: 'indexer processes add-owner proposal',
  });
  expect(proposal.approvalCount).toBe(1); // auto-approved by proposer
});

// ---------------------------------------------------------------------------
// 8. Execute add owner proposal
// ---------------------------------------------------------------------------

test('8. Execute add owner proposal', async () => {
  log('=== Step 8: Execute add owner ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];
  await executeProposal(proposalHash, {
    waitDescription: 'indexer processes owner change execution',
  });

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
// 9. Propose: change threshold to 2/2
// ---------------------------------------------------------------------------

test('9. Propose change threshold to 2/2', async () => {
  log('=== Step 9: Propose threshold change ===');
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

  await proposeViaForm({
    type: 'changeThreshold',
    fill: async () => {
      // Backend has numOwners=2 but the UI may still be on the previous 15s
      // useMultisig poll. Wait for the form to actually render "out of 2"
      // before filling, otherwise input max=1 and the submit fails validation.
      log('Waiting for form to reflect numOwners=2...');
      await expect(sharedPage.getByText('out of 2')).toBeVisible({ timeout: 30_000 });
      await sharedPage.locator('input[type="number"]').first().fill('2');
    },
    match: (p) => p.txType === 'changeThreshold',
    waitDescription: 'indexer processes threshold proposal',
  });
});

// ---------------------------------------------------------------------------
// 10. Execute threshold change
// ---------------------------------------------------------------------------

test('10. Execute threshold change', async () => {
  log('=== Step 10: Execute threshold change ===');
  await executeProposal(proposalHashes[proposalHashes.length - 1], {
    waitDescription: 'indexer processes threshold change execution',
  });

  const contract = await getContract(contractAddress);
  expect(contract.threshold).toBe(2);
  log(`Threshold updated: ${contract.threshold}/${contract.numOwners}`);
});

// ===========================================================================
// MULTI-SIG PHASE (threshold 2/2): transfer with memo, approved by owner 2
// ===========================================================================

// ---------------------------------------------------------------------------
// 11. Propose: send MINA to account3 (with memo)
// ---------------------------------------------------------------------------

test('11. Propose send MINA to account3 (with memo)', async () => {
  log('=== Step 11: Propose MINA transfer ===');
  // The transfer form defaults to per-row inputs; fillRecipients flips to
  // Bulk mode and writes the legacy `address,amount` format. 1 MINA to account3.
  // The memo lifecycle (input, byte counter, hash match after execution) rides
  // this transfer instead of a separate propose/execute pair.
  const proposal = await proposeViaForm({
    type: 'transfer',
    fill: async () => {
      const page = sharedPage;
      await fillRecipients(page, `${accounts[2].publicKey},1`);

      const memoInput = page.locator('input[placeholder*="memo"]').or(
        page.locator('input[placeholder*="Short note"]')
      );
      await memoInput.waitFor({ state: 'visible', timeout: 5_000 });
      await memoInput.fill('e2e-test-memo');

      const byteCounter = page.locator('text=13 / 32 bytes');
      await expect(byteCounter).toBeVisible({ timeout: 3_000 });
      log('Byte counter shows 13 / 32');
    },
    match: (p) => p.txType === 'transfer',
    waitDescription: 'indexer processes transfer proposal',
  });
  expect(proposal.approvalCount).toBe(1); // auto-approved by proposer
  expect(proposal.memo).toBe('e2e-test-memo');
  expect(proposal.memoHash).toBeTruthy();
  log(`Memo committed: memoHash=${proposal.memoHash?.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// 12. Approve transfer (account2)
// ---------------------------------------------------------------------------

test('12. Approve transfer (account2)', async () => {
  log('=== Step 12: Approve transfer (account2) ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];

  // Memo is displayed on the proposal detail page (approver's view). Checked
  // before approving — the post-approve flow redirects to the list view.
  await gotoWithWallet(`/transactions/${proposalHash}`, accounts[1]);
  await sharedPage.waitForTimeout(SHORT_WAIT);
  await expect(sharedPage.locator('text=e2e-test-memo')).toBeVisible({ timeout: 10_000 });
  log('Memo visible on proposal detail page');

  await approveProposal(proposalHash, accounts[1], 2);

  // Verify approval records
  const approvals = await getApprovals(contractAddress, proposalHash);
  expect(approvals).toHaveLength(2);
  log(
    `Approvers: ${approvals.map((a: any) => a.approver.slice(0, 12) + '...').join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// 13. Execute transfer (account2)
// ---------------------------------------------------------------------------

test('13. Execute transfer (account2)', async () => { const page = sharedPage;
  log('=== Step 13: Execute transfer (account2) ===');
  const proposalHash = proposalHashes[proposalHashes.length - 1];

  // Wait for the approval from step 12 to be fully settled on-chain
  // before attempting execute. The on-chain approvalRoot must reflect
  // the new approval, otherwise the Merkle witness will be invalid.
  log('Waiting for on-chain state to settle after approval...');
  await new Promise((r) => setTimeout(r, SETTLE_WAIT));

  await executeProposal(proposalHash, {
    account: accounts[1],
    waitDescription: 'indexer processes transfer execution',
    timeoutMs: 360_000, // 6 min — last step, lightnet may be slow after many txs
    intervalMs: 10_000,
    onBanner: async (bannerText) => {
      // Extract tx hash from banner and check its on-chain status
      const txHashMatch = bannerText.match(/5J[a-zA-Z0-9]+/);
      if (txHashMatch) {
        log(`Execute tx hash: ${txHashMatch[0]}`);
        // Give the node time to process, then check status
        await new Promise((r) => setTimeout(r, SETTLE_WAIT));
        await checkTxStatus(txHashMatch[0]);
      }
    },
    until: async () => {
      const proposal = await getProposal(contractAddress, proposalHash);
      if (proposal) {
        log(`  Proposal status: ${proposal.status}, approvals: ${proposal.approvalCount}`);
      }
      return proposal?.status === 'executed';
    },
  });

  const proposal = await getProposal(contractAddress, proposalHash);
  expect(proposal.status).toBe('executed');
  log(`Transfer proposal executed at block ${proposal.executedAtBlock}`);

  // The executed tx carried the committed memo (end-to-end memo happy path;
  // the mismatch/stripped cases are unit-tested in backend proposal-record tests)
  expect(proposal.memo).toBe('e2e-test-memo');
  expect(proposal.proposalMemoMatch).toBe(true);
  expect(proposal.memoExecutionMatch).toBe(true);
  log(`Memo match verified: proposalMemoMatch=${proposal.proposalMemoMatch}, memoExecutionMatch=${proposal.memoExecutionMatch}`);

  // Verify the UI shows executed status and the memo match indicator
  await navigateTo(page, `/transactions/${proposalHash}`);
  const statusBadge = page.locator('text=executed').or(page.locator('text=Executed'));
  await expect(statusBadge.first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=e2e-test-memo')).toBeVisible({ timeout: 10_000 });
  log('UI shows executed status with memo');

  log('Transfer execution verified');
});

// ===========================================================================
// FINAL STATE
// ===========================================================================

// ---------------------------------------------------------------------------
// 14. Verify final state after all operations
// ---------------------------------------------------------------------------

test('14. Verify final state', async () => { const page = sharedPage;
  log('=== Step 14: Verify final state ===');

  // The page recycle after step 13 reloads the app with the child as the active
  // vault; re-select the parent before checking its settings (cf. step 5).
  await gotoWithWallet(`/accounts/${contractAddress}`, accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);

  // Settings — 2 owners, threshold 2
  await gotoWithWallet('/settings', accounts[0]);
  await page.waitForTimeout(SHORT_WAIT);
  await expect(page.locator('text=Owners (2)')).toBeVisible({ timeout: 10_000 });
  log('Settings shows 2 owners');

  // Transactions — createChild, allocateChild, delete, addOwner,
  // changeThreshold, transfer all executed; the delete target invalidated;
  // nothing pending.
  await navigateTo(page, '/transactions');
  await page.waitForTimeout(SHORT_WAIT);

  await expectTabCount(/Pending/i, 0);
  await expectTabCount(/Executed/i, 6);
  await expectTabCount(/Invalidated/i, 1);

  // Final dump
  log('\n=== Final State ===');
  await dumpState(contractAddress);
  log('\n=== Golden path completed successfully! ===');
});
