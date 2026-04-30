// -- UI Local Storage Utilities ---------------------------------------

const STORAGE_KEY_PREFIX = 'mina-guard-ui-';

/** Builds namespaced localStorage key names for UI preferences. */
function getKey(suffix: string): string {
  return `${STORAGE_KEY_PREFIX}${suffix}`;
}

/** Persists selected contract address for restoring UI context on reload. */
export function saveSelectedContract(address: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(getKey('selected-contract'), address);
}

/** Restores previously selected contract address preference if present. */
export function getSelectedContract(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(getKey('selected-contract'));
}

/** Clears all UI preference entries managed by this module. */
export function clearUiStorage(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(getKey('selected-contract'));
}

/** Returns whether compile caching is enabled (default: true). */
export function isCompileCacheEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(getKey('compile-cache-enabled')) !== 'false';
}

/** Persists the compile cache enabled/disabled preference. */
export function setCompileCacheEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(getKey('compile-cache-enabled'), String(enabled));
}

/** Saves a user-assigned display name for a contract address. */
export function saveAccountName(address: string, name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim();
  if (trimmed) {
    localStorage.setItem(getKey(`name:${address}`), trimmed);
  } else {
    localStorage.removeItem(getKey(`name:${address}`));
  }
}

/** Returns the user-assigned display name for a contract address, if any. */
export function getAccountName(address: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(getKey(`name:${address}`));
}

// -- Pending in-flight transactions ------------------------------------
//
// One generic store covers four flavors of "tx is broadcast, awaiting
// inclusion": create, approve, execute, deploy. The `useTransactions` hook
// reconciles these against the indexer each tick and clears them once the
// on-chain reality matches.

/** `deploy` covers the brand-new top-level contract deployment flow
 *  (`deployAndSetupContract`) and the CREATE_CHILD wizard's "Finalize
 *  deployment" step. It has no proposalHash — the contract address itself
 *  is the unique identity, stored in `proposalHash` as a sentinel. */
export type PendingTxKind = 'create' | 'approve' | 'execute' | 'deploy';

/** Snapshot of proposal data captured at creation time so the detail page
 *  can render a meaningful card before the indexer catches up. Only set on
 *  `kind='create'` records. */
export interface PendingTxSummary {
  txType: string | null;
  nonce: string | null;
  configNonce: string | null;
  expiryBlock: string | null;
  destination: 'local' | 'remote' | null;
  childAccount: string | null;
  receivers: { address: string; amount: string }[];
}

export interface PendingTx {
  kind: PendingTxKind;
  contractAddress: string;
  proposalHash: string;
  /** Mina tx hash returned by the daemon. */
  txHash: string;
  /** Submitting wallet's base58 pubkey. */
  signerPubkey: string;
  createdAt: string;
  summary?: PendingTxSummary;
}

const PENDING_TXS_KEY = getKey('pending-txs');
/** 24h prune window — survives long-lived sessions. */
const PENDING_TX_TTL_MS = 24 * 60 * 60 * 1000;

/** Custom event dispatched on save/clear so banners can refresh in the same tab.
 *  The native `storage` event only fires across tabs, so we use a custom event. */
export const PENDING_TXS_CHANGED = 'mina-guard-pending-txs-changed';

function notifyPendingTxsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PENDING_TXS_CHANGED));
}

function pruneStale(records: PendingTx[]): PendingTx[] {
  const now = Date.now();
  return records.filter((r) => {
    const ts = new Date(r.createdAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return now - ts < PENDING_TX_TTL_MS;
  });
}

function readPendingTxsRaw(): PendingTx[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(PENDING_TXS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PendingTx[];
  } catch {
    // Bad JSON — fall through and return empty.
  }
  return [];
}

function writePendingTxs(records: PendingTx[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PENDING_TXS_KEY, JSON.stringify(records));
}

function pendingTxKey(r: PendingTx): string {
  return `${r.contractAddress}::${r.proposalHash}::${r.kind}::${r.signerPubkey}`;
}

/** Returns all currently-tracked pending tx records (TTL-pruned). */
export function getPendingTxs(): PendingTx[] {
  const records = pruneStale(readPendingTxsRaw());
  return records;
}

/** Lists pending tx records scoped to a single contract. */
export function getPendingTxsForContract(contractAddress: string): PendingTx[] {
  return getPendingTxs().filter((r) => r.contractAddress === contractAddress);
}

/** Looks up a single record. When `signerPubkey` is omitted, returns the
 *  first match — useful for queries like "is there *any* in-flight execute?". */
export function getPendingTx(
  contractAddress: string,
  proposalHash: string,
  kind: PendingTxKind,
  signerPubkey?: string,
): PendingTx | undefined {
  return getPendingTxs().find(
    (r) =>
      r.contractAddress === contractAddress &&
      r.proposalHash === proposalHash &&
      r.kind === kind &&
      (signerPubkey === undefined || r.signerPubkey === signerPubkey),
  );
}

/** Inserts or replaces a pending tx record keyed by (contract, proposal, kind, signer). */
export function savePendingTx(record: PendingTx): void {
  const next = readPendingTxsRaw().filter((r) => pendingTxKey(r) !== pendingTxKey(record));
  next.push(record);
  writePendingTxs(pruneStale(next));
  notifyPendingTxsChanged();
}

/** Removes any record matching the (contract, proposal, kind[, signer]) key. */
export function clearPendingTx(
  contractAddress: string,
  proposalHash: string,
  kind: PendingTxKind,
  signerPubkey?: string,
): void {
  const next = readPendingTxsRaw().filter(
    (r) =>
      !(
        r.contractAddress === contractAddress &&
        r.proposalHash === proposalHash &&
        r.kind === kind &&
        (signerPubkey === undefined || r.signerPubkey === signerPubkey)
      ),
  );
  writePendingTxs(pruneStale(next));
  notifyPendingTxsChanged();
}

