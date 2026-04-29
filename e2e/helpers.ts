import { type Page, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Mina,
  PrivateKey,
  PublicKey,
  UInt64,
  AccountUpdate,
  fetchAccount,
} from 'o1js';
import { getNetworkConfig } from './network-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestAccount {
  publicKey: string;
  privateKey: string;
}

export interface E2eState {
  accounts: TestAccount[];
  backendPid: number;
  frontendPid: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[e2e ${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export function loadState(): E2eState {
  const statePath = resolve(import.meta.dirname, '.e2e-state.json');
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Backend API helpers
// ---------------------------------------------------------------------------

const API = getNetworkConfig().backendUrl;

export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getIndexerStatus(): Promise<any | null> {
  return apiGet('/api/indexer/status');
}

export async function getContracts(): Promise<any[]> {
  return (await apiGet<any[]>('/api/contracts')) ?? [];
}

export async function getContract(address: string): Promise<any | null> {
  return apiGet(`/api/contracts/${address}`);
}

export async function getOwners(address: string): Promise<any[]> {
  return (await apiGet<any[]>(`/api/contracts/${address}/owners`)) ?? [];
}

/** Maps numeric txType values from the backend to human-readable names. */
function normalizeTxType(value: string | null): string | null {
  if (!value) return null;
  const map: Record<string, string> = {
    '0': 'transfer',
    '1': 'addOwner',
    '2': 'removeOwner',
    '3': 'changeThreshold',
    '4': 'setDelegate',
    '5': 'createChild',
    '6': 'allocateChild',
    '7': 'reclaimChild',
    '8': 'destroyChild',
    '9': 'enableChildMultiSig',
  };
  return map[value] ?? value;
}

export async function getChildren(parentAddress: string): Promise<any[]> {
  return (await apiGet<any[]>(`/api/contracts/${parentAddress}/children`)) ?? [];
}

/** Reads an account's on-chain balance in nanomina, or 0 if the account doesn't exist. */
export async function getAccountBalance(address: string): Promise<bigint> {
  const pub = PublicKey.fromBase58(address);
  const result = await fetchAccount({ publicKey: pub });
  return result.account ? BigInt(result.account.balance.toBigInt()) : 0n;
}

export async function getProposals(
  address: string,
  status?: string
): Promise<any[]> {
  const qs = status ? `?status=${status}` : '';
  const proposals =
    (await apiGet<any[]>(`/api/contracts/${address}/proposals${qs}`)) ?? [];
  return proposals.map((p) => ({ ...p, txType: normalizeTxType(p.txType) }));
}

export async function getProposal(
  address: string,
  proposalHash: string
): Promise<any | null> {
  const p = await apiGet<any>(`/api/contracts/${address}/proposals/${proposalHash}`);
  if (p) p.txType = normalizeTxType(p.txType);
  return p;
}

export async function getApprovals(
  address: string,
  proposalHash: string
): Promise<any[]> {
  return (
    (await apiGet<any[]>(
      `/api/contracts/${address}/proposals/${proposalHash}/approvals`
    )) ?? []
  );
}

// ---------------------------------------------------------------------------
// Indexer polling
// ---------------------------------------------------------------------------

/**
 * Polls a check function until it returns true or timeout is reached.
 * Logs a dot every interval to show progress.
 */
export async function waitForIndexer(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs?: number,
  intervalMs?: number,
): Promise<void> {
  const config = getNetworkConfig();
  timeoutMs ??= config.indexerTimeoutMs;
  intervalMs ??= config.indexerPollIntervalMs;
  log(`Waiting: ${description}`);
  const start = Date.now();
  let dots = 0;
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    const ok = await check();
    if (ok) {
      log(`  Done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      return;
    }
    dots++;
    if (dots % 5 === 0) {
      const status = await getIndexerStatus();
      const err = status?.lastError;
      if (err && err !== lastError) {
        log(`  ⚠ Indexer error: ${err}`);
        lastError = err;
      }
      log(`  Still waiting... (${((Date.now() - start) / 1000).toFixed(0)}s) [height=${status?.indexedHeight ?? '?'}]`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const finalStatus = await getIndexerStatus();
  log(`  Indexer status at timeout: ${JSON.stringify(finalStatus)}`);
  throw new Error(
    `Timed out after ${(timeoutMs / 1000).toFixed(0)}s waiting: ${description}`
  );
}

// ---------------------------------------------------------------------------
// Contract funding (sends MINA from a test account to the contract)
// ---------------------------------------------------------------------------

let minaNetworkConfigured = false;

/**
 * Sends MINA from a funded test account to the contract address so the
 * contract has enough balance to execute transfer proposals.
 */
export async function fundContract(
  contractAddress: string,
  funder: TestAccount,
  amountMina: number = 10
): Promise<void> {
  if (!minaNetworkConfigured) {
    const config = getNetworkConfig();
    Mina.setActiveInstance(
      Mina.Network({
        mina: config.minaEndpoint,
        archive: config.archiveEndpoint,
      })
    );
    minaNetworkConfigured = true;
  }

  const funderKey = PrivateKey.fromBase58(funder.privateKey);
  const funderPub = PublicKey.fromBase58(funder.publicKey);
  const target = PublicKey.fromBase58(contractAddress);
  const amount = UInt64.from(amountMina * 1_000_000_000);
  const fee = UInt64.from(100_000_000); // 0.1 MINA

  log(`Funding contract ${contractAddress.slice(0, 12)}... with ${amountMina} MINA`);
  await fetchAccount({ publicKey: funderPub });

  const tx = await Mina.transaction({ sender: funderPub, fee }, async () => {
    const update = AccountUpdate.createSigned(funderPub);
    update.send({ to: target, amount });
  });
  // No tx.prove() needed — simple payment uses signature auth only
  tx.sign([funderKey]);
  const result = await tx.send();
  const hash =
    typeof result.hash === 'function'
      ? (result.hash as () => string)()
      : result.hash;
  log(`  Fund tx sent: ${hash}`);
  // Poll the contract's on-chain balance to confirm inclusion.
  // result.wait() can hang indefinitely on devnet, so we check the actual
  // outcome instead: the target account's balance increasing.
  const config = getNetworkConfig();
  const timeoutMs = config.indexerTimeoutMs; // 240s lightnet, 900s devnet
  const pollMs = config.indexerPollIntervalMs;
  const start = Date.now();

  // Snapshot balance before (account may not exist yet → 0)
  const before = await fetchAccount({ publicKey: target });
  const balanceBefore = before.account
    ? BigInt(before.account.balance.toBigInt())
    : 0n;
  log(`  Contract balance before: ${balanceBefore} nanomina`);

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const acct = await fetchAccount({ publicKey: target });
    const bal = acct.account ? BigInt(acct.account.balance.toBigInt()) : 0n;
    if (bal > balanceBefore) {
      log(`  Fund tx confirmed — balance: ${bal} nanomina (+${bal - balanceBefore})`);
      return;
    }
    if ((Date.now() - start) % (pollMs * 5) < pollMs) {
      log(`  Still waiting for fund tx inclusion... (${((Date.now() - start) / 1000).toFixed(0)}s)`);
    }
  }
  throw new Error(
    `Fund tx not confirmed after ${(timeoutMs / 1000).toFixed(0)}s — contract balance did not increase`
  );
}

// ---------------------------------------------------------------------------
// Client-side navigation (preserves Web Worker across route changes)
// ---------------------------------------------------------------------------

/**
 * Navigates using Next.js client-side router instead of a full page reload.
 * This keeps the Web Worker (and compiled contract) alive between tests.
 */
export async function navigateTo(
  page: Page,
  path: string,
  timeoutMs = 30_000
): Promise<void> {
  await page.evaluate((p) => (window as any).__e2eNavigate(p), path);
  // Wait for the pathname to update. `__e2ePathname()` returns Next's
  // `usePathname()` which is pathname-only, so strip any query string from
  // the expected path before comparing.
  await page.waitForFunction(
    (expected) => {
      const pathOnly = expected.split('?')[0];
      return (window as any).__e2ePathname() === pathOnly;
    },
    path,
    { timeout: timeoutMs }
  );
  // Let React render settle
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------------------
// Mock wallet injection
// ---------------------------------------------------------------------------

/** Script injected into the page before app JS loads. Sets up a fake window.mina. */
const MOCK_WALLET_SCRIPT = `
  window.__testActiveAddress = null;
  window.__testEventHandlers = {};

  window.mina = {
    requestAccounts() {
      return Promise.resolve(
        window.__testActiveAddress ? [window.__testActiveAddress] : []
      );
    },
    getAccounts() {
      return Promise.resolve(
        window.__testActiveAddress ? [window.__testActiveAddress] : []
      );
    },
    requestNetwork() {
      return Promise.resolve({ chainId: 'testnet', name: 'testnet' });
    },
    sendTransaction() {
      // In test mode the worker signs and sends directly; this is a no-op fallback.
      return Promise.resolve({ hash: 'mock-unused' });
    },
    signFields() {
      return Promise.resolve({ data: [], signature: '' });
    },
    signMessage() {
      return Promise.resolve({
        publicKey: '', data: '',
        signature: { field: '0', scalar: '0' },
      });
    },
    on(event, handler) {
      if (!window.__testEventHandlers[event]) {
        window.__testEventHandlers[event] = [];
      }
      window.__testEventHandlers[event].push(handler);
    },
    removeListener(event, handler) {
      if (window.__testEventHandlers[event]) {
        window.__testEventHandlers[event] =
          window.__testEventHandlers[event].filter(function(h) { return h !== handler; });
      }
    },
  };

  window.__testSwitchAccount = function(newAddress) {
    window.__testActiveAddress = newAddress;
    var handlers = window.__testEventHandlers['accountsChanged'] || [];
    handlers.forEach(function(h) { h([newAddress]); });
  };
`;

/**
 * Prepares a page for e2e testing:
 * 1. Injects the mock wallet (runs before any page JS)
 * 2. After navigation, sets the active account and test key on the worker
 */
export async function setupTestPage(
  page: Page,
  account: TestAccount
): Promise<void> {
  await page.addInitScript(MOCK_WALLET_SCRIPT);
  // Set active address before navigation triggers wallet detection
  await page.addInitScript(`window.__testActiveAddress = "${account.publicKey}";`);
}

/**
 * After the page has loaded and the worker is ready, set the test key
 * so the worker signs/sends directly instead of going through Auro.
 */
export async function activateTestKey(
  page: Page,
  account: TestAccount
): Promise<void> {
  const config = getNetworkConfig();
  log(`Setting test key for account ${account.publicKey.slice(0, 12)}...`);
  // Wait for the worker to be initialized (the __e2eSetTestKey global)
  await page.waitForFunction(
    () => typeof (window as any).__e2eSetTestKey === 'function',
    { timeout: 120_000 }
  );
  await page.evaluate(
    async (pk: string) => (window as any).__e2eSetTestKey(pk),
    account.privateKey
  );
  if (config.skipProofs) {
    await page.evaluate(
      async () => (window as any).__e2eSetSkipProofs(true)
    );
  }
}

/**
 * Switches the active wallet account in the mock and updates the worker's
 * signing key.
 */
export async function switchAccount(
  page: Page,
  account: TestAccount
): Promise<void> {
  log(`Switching to account ${account.publicKey.slice(0, 12)}...`);
  await page.evaluate(
    (addr: string) => (window as any).__testSwitchAccount(addr),
    account.publicKey
  );
  await page.evaluate(
    async (pk: string) => (window as any).__e2eSetTestKey(pk),
    account.privateKey
  );
  // Give the app context a moment to process the account change
  await page.waitForTimeout(1_000);
}

// ---------------------------------------------------------------------------
// UI interaction helpers
// ---------------------------------------------------------------------------

/**
 * Dismisses any existing operation banner, then waits for a fresh one to appear.
 * This prevents picking up a stale banner from a previous operation.
 */
export async function waitForBanner(
  page: Page,
  type: 'success' | 'error' = 'success',
  timeoutMs?: number
): Promise<string> {
  timeoutMs ??= getNetworkConfig().bannerTimeoutMs;

  // Dismiss any stale banner, then wait for it to leave the DOM before
  // polling for the new result.  This prevents a race where a fast operation
  // (e.g. offchain approve) completes and shows its banner before we finish
  // dismissing the old one — causing us to accidentally close the real result.
  const closeBtn = page.locator('button:has-text("×")');
  if (await closeBtn.first().isVisible().catch(() => false)) {
    await closeBtn.first().click().catch(() => {});
    log('Dismissed stale banner');
    // Wait until the old banner is actually gone from the DOM
    await page.waitForFunction(
      () => {
        const btns = Array.from(document.querySelectorAll('button')).filter(
          (b) => b.textContent?.trim() === '×'
        );
        const hasBanner = btns.some((btn) => {
          const cls = btn.parentElement?.className ?? '';
          return cls.includes('text-safe-green') || cls.includes('text-red-400');
        });
        return !hasBanner;
      },
      { timeout: 5_000 }
    ).catch(() => {});
  }

  log('Waiting for operation banner...');
  // Success banners use text-safe-green class; error banners use text-red-400.
  // We wait for the × close button to appear inside a banner of the right type.
  await page.waitForFunction(
    (expectedType: string) => {
      const btns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent?.trim() === '×'
      );
      return btns.some((btn) => {
        const parent = btn.parentElement;
        if (!parent) return false;
        const cls = parent.className ?? '';
        return expectedType === 'success'
          ? cls.includes('text-safe-green')
          : cls.includes('text-red-400');
      });
    },
    type,
    { timeout: timeoutMs }
  );
  const bannerEl = page.locator(
    type === 'success' ? '.text-safe-green' : '.text-red-400'
  ).first();
  const text = await bannerEl.textContent();
  log(`  Banner: ${text?.trim()}`);
  return text?.trim() ?? '';
}

/**
 * Fills the recipients section of the new-proposal form using its Bulk mode
 * (one `address,amount` per line). The form defaults to per-row inputs; tests
 * predate that change and rely on the legacy comma-separated format, so this
 * helper switches to Bulk mode if needed before writing.
 */
export async function fillRecipients(page: Page, content: string): Promise<void> {
  const textarea = page.locator('textarea').first();
  if (!(await textarea.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Bulk', exact: true }).click();
    await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  }
  await textarea.fill(content);
}

/** Waits for the operating spinner to disappear. */
export async function waitForOperationDone(
  page: Page,
  timeoutMs = 600_000
): Promise<void> {
  // The spinner shows operationLabel text; wait for it to disappear
  // We look for the spinner overlay that appears during operations
  try {
    await page.waitForFunction(
      () => {
        // Check that no spinner/loading overlay is present
        const spinners = document.querySelectorAll('[class*="animate-spin"]');
        return spinners.length === 0;
      },
      { timeout: timeoutMs }
    );
  } catch {
    // If no spinner was found at all, that's fine
  }
}

/**
 * Scans recent blocks on the Mina daemon to find a zkApp transaction by hash
 * and report whether it succeeded or had on-chain failures.
 */
export async function checkTxStatus(txHash: string): Promise<string> {
  try {
    const res = await fetch(getNetworkConfig().minaEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ bestChain(maxLength: 30) {
          protocolState { consensusState { blockHeight } }
          transactions { zkappCommands { hash failureReason { failures } } }
        } }`,
      }),
    });
    const data = (await res.json()) as any;
    const blocks = data?.data?.bestChain ?? [];
    for (const block of blocks) {
      const height = block.protocolState?.consensusState?.blockHeight;
      for (const cmd of block.transactions?.zkappCommands ?? []) {
        if (cmd.hash === txHash) {
          const failures = (cmd.failureReason ?? [])
            .flatMap((f: any) => f.failures ?? [])
            .filter(Boolean);
          if (failures.length > 0) {
            log(`Transaction ${txHash.slice(0, 16)}... FAILED at block ${height}: ${failures.join(', ')}`);
            return 'failed';
          }
          log(`Transaction ${txHash.slice(0, 16)}... SUCCEEDED at block ${height}`);
          return 'applied';
        }
      }
    }
    // Check if it's still in the mempool
    const poolRes = await fetch(getNetworkConfig().minaEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ pooledZkappCommands { hash } }`,
      }),
    });
    const poolData = (await poolRes.json()) as any;
    const inPool = (poolData?.data?.pooledZkappCommands ?? []).some(
      (c: any) => c.hash === txHash
    );
    if (inPool) {
      log(`Transaction ${txHash.slice(0, 16)}... is in mempool (not yet included)`);
      return 'pending';
    }
    log(`Transaction ${txHash.slice(0, 16)}... not found in recent blocks or mempool`);
    return 'not_found';
  } catch (err) {
    log(`Failed to query tx status: ${err}`);
    return 'query_failed';
  }
}

/**
 * Dumps backend state for debugging on test failure.
 */
export async function dumpState(contractAddress?: string): Promise<string> {
  const lines: string[] = ['=== Backend State Dump ==='];

  const contracts = await getContracts();
  lines.push(`Contracts: ${contracts.length}`);
  for (const c of contracts) {
    lines.push(
      `  ${c.address}: threshold=${c.threshold}, numOwners=${c.numOwners}, configNonce=${c.configNonce}`
    );
  }

  if (contractAddress) {
    const owners = await getOwners(contractAddress);
    lines.push(`\nOwners for ${contractAddress.slice(0, 12)}...:`);
    for (const o of owners) {
      lines.push(`  ${o.address}: active=${o.active}`);
    }

    const proposals = await getProposals(contractAddress);
    lines.push(`\nProposals: ${proposals.length}`);
    for (const p of proposals) {
      lines.push(
        `  ${p.proposalHash?.slice(0, 12)}...: type=${p.txType}, status=${p.status}, approvals=${p.approvalCount}`
      );
    }
  }

  const dump = lines.join('\n');
  console.log(dump);
  return dump;
}
