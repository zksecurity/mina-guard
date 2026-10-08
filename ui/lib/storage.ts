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
  expirySlot: string | null;
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
  /** Set when the backend refused to record this approve/execute, or stopped
   *  tracking it. The backend then never reports the transaction's failure,
   *  so the record expires sooner (UNTRACKED_PENDING_TX_TTL_MS). */
  untracked?: boolean;
  /** Set when the backend accepted the report for this approve/execute, so
   *  later polls can tell whether it still tracks this hash. */
  recorded?: boolean;
}

const PENDING_TXS_KEY = getKey('pending-txs');
/** 24h prune window — survives long-lived sessions. */
const PENDING_TX_TTL_MS = 24 * 60 * 60 * 1000;
/** Prune window for a record the backend refused to track: without it a failed
 *  or dropped transaction would lock the vault in this tab for a day. It
 *  matches the backend's 20-minute wait before it calls a transaction dropped. */
export const UNTRACKED_PENDING_TX_TTL_MS = 20 * 60 * 1000;

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
    return now - ts < (r.untracked ? UNTRACKED_PENDING_TX_TTL_MS : PENDING_TX_TTL_MS);
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

/** Sets a flag on the approve/execute record for this tx hash, if it lacks it. */
function flagPendingTx(
  contractAddress: string,
  proposalHash: string,
  kind: PendingTxKind,
  txHash: string,
  flag: 'untracked' | 'recorded',
): void {
  let changed = false;
  const next = readPendingTxsRaw().map((r) => {
    const match = r.contractAddress === contractAddress && r.proposalHash === proposalHash
      && r.kind === kind && r.txHash === txHash;
    if (!match || r[flag]) return r;
    changed = true;
    return { ...r, [flag]: true };
  });
  if (!changed) return;
  writePendingTxs(pruneStale(next));
  notifyPendingTxsChanged();
}

/** Marks the approve/execute record for this tx hash as untracked by the backend. */
export function markPendingTxUntracked(
  contractAddress: string,
  proposalHash: string,
  kind: PendingTxKind,
  txHash: string,
): void {
  flagPendingTx(contractAddress, proposalHash, kind, txHash, 'untracked');
}

/** Marks the approve/execute record for this tx hash as recorded by the backend. */
export function markPendingTxRecorded(
  contractAddress: string,
  proposalHash: string,
  kind: PendingTxKind,
  txHash: string,
): void {
  flagPendingTx(contractAddress, proposalHash, kind, txHash, 'recorded');
}

/** How long a report may go unanswered before the record is treated as
 *  untracked: the backend answers within seconds, so a longer silence means
 *  the answer was lost (a reload mid-report) and nothing will set `recorded`. */
export const REPORT_ANSWER_GRACE_MS = 2 * 60 * 1000;

/** True when the backend never answered this record's report within the grace. */
export function reportUnanswered(record: PendingTx, now = Date.now()): boolean {
  if (record.recorded || record.untracked) return false;
  if (record.kind !== 'approve' && record.kind !== 'execute') return false;
  const createdAt = new Date(record.createdAt).getTime();
  return Number.isFinite(createdAt) && now - createdAt > REPORT_ANSWER_GRACE_MS;
}

/** True when the backend accepted this record's report but no longer tracks
 *  its hash: a later report replaced it (whether that transaction is still
 *  live or already failed), or the replacement was applied and cleared before
 *  this tab polled. The backend will then never report this record's failure.
 *  False while the report is unanswered, so an in-flight report is not judged;
 *  a failure of this record's own hash is for the caller's normal cleanup. */
export function backendNoLongerTracks(
  record: PendingTx,
  row: { lastApproveTxHash: string | null; lastExecuteTxHash: string | null },
): boolean {
  if (!record.recorded) return false;
  const hash = record.kind === 'approve'
    ? row.lastApproveTxHash
    : record.kind === 'execute'
      ? row.lastExecuteTxHash
      : record.txHash;
  return hash !== record.txHash;
}

/** Deletes expired records and notifies listeners when any went, so a lock held
 *  by an expired record lifts without a page reload. */
export function prunePendingTxs(): void {
  const records = readPendingTxsRaw();
  const kept = pruneStale(records);
  if (kept.length === records.length) return;
  writePendingTxs(kept);
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

