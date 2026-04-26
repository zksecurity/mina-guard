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
// One generic store covers three flavors of "tx is broadcast, awaiting
// inclusion": create, approve, execute. The `useTransactions` hook
// reconciles these against the indexer each tick and clears them once the
// on-chain reality matches. The legacy `PendingSubaccount` API is kept as
// a thin compat layer so the CREATE_CHILD wizard's "Finalize deployment"
// flow keeps working.

export type PendingTxKind = 'create' | 'approve' | 'execute';

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

/** CREATE_CHILD wizard state needed to finalize the child deployment after
 *  the parent proposal lands. Only set on CREATE_CHILD `kind='create'` records. */
export interface PendingTxChildAccount {
  childAddress: string;
  childPrivateKey: string;
  childOwners: string[];
  childThreshold: number;
  childName: string;
  expiryBlock: number | null;
}

export interface PendingTx {
  kind: PendingTxKind;
  contractAddress: string;
  proposalHash: string;
  /** Mina tx hash returned by the daemon. May be empty when imported from
   *  the legacy PendingSubaccount store, which never recorded it. */
  txHash: string;
  /** Submitting wallet's base58 pubkey. Empty for legacy-imported records. */
  signerPubkey: string;
  createdAt: string;
  summary?: PendingTxSummary;
  childAccount?: PendingTxChildAccount;
}

const PENDING_TXS_KEY = getKey('pending-txs');
const LEGACY_PENDING_SUBACCOUNTS_KEY = getKey('pending-subaccounts');
/** 24h prune window — survives long-lived sessions and matches the prior
 *  PendingSubaccount cadence. */
const PENDING_TX_TTL_MS = 24 * 60 * 60 * 1000;

/** Custom event dispatched on save/clear so banners can refresh in the same tab.
 *  The native `storage` event only fires across tabs, so we use a custom event. */
export const PENDING_TXS_CHANGED = 'mina-guard-pending-txs-changed';
/** Legacy event preserved so existing PendingSubaccountsBanner listeners still trigger. */
export const PENDING_SUBACCOUNTS_CHANGED = 'mina-guard-pending-subaccounts-changed';

function notifyPendingTxsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PENDING_TXS_CHANGED));
  window.dispatchEvent(new CustomEvent(PENDING_SUBACCOUNTS_CHANGED));
}

function pruneStale(records: PendingTx[]): PendingTx[] {
  const now = Date.now();
  return records.filter((r) => {
    const ts = new Date(r.createdAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return now - ts < PENDING_TX_TTL_MS;
  });
}

function migrateLegacyPendingSubaccounts(): PendingTx[] {
  if (typeof window === 'undefined') return [];
  const legacy = localStorage.getItem(LEGACY_PENDING_SUBACCOUNTS_KEY);
  if (!legacy) return [];
  try {
    const parsed = JSON.parse(legacy);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(LEGACY_PENDING_SUBACCOUNTS_KEY);
      return [];
    }
    const migrated: PendingTx[] = parsed.map((r: Record<string, unknown>) => ({
      kind: 'create',
      contractAddress: String(r.parentAddress ?? ''),
      proposalHash: String(r.proposalHash ?? ''),
      txHash: '',
      signerPubkey: '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
      childAccount: {
        childAddress: String(r.childAddress ?? ''),
        childPrivateKey: String(r.childPrivateKey ?? ''),
        childOwners: Array.isArray(r.childOwners) ? (r.childOwners as string[]) : [],
        childThreshold: typeof r.childThreshold === 'number' ? r.childThreshold : 0,
        childName: typeof r.childName === 'string' ? r.childName : '',
        expiryBlock:
          typeof r.expiryBlock === 'number' || r.expiryBlock === null
            ? (r.expiryBlock as number | null)
            : null,
      },
    }));
    localStorage.removeItem(LEGACY_PENDING_SUBACCOUNTS_KEY);
    return migrated;
  } catch {
    localStorage.removeItem(LEGACY_PENDING_SUBACCOUNTS_KEY);
    return [];
  }
}

function readPendingTxsRaw(): PendingTx[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(PENDING_TXS_KEY);
  let records: PendingTx[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records = parsed as PendingTx[];
    } catch {
      // Bad JSON — drop and rewrite below.
    }
  }
  const migrated = migrateLegacyPendingSubaccounts();
  if (migrated.length > 0) {
    records = [...records, ...migrated];
    writePendingTxs(records);
  }
  return records;
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

// -- Legacy PendingSubaccount compat layer -----------------------------
//
// The CREATE_CHILD wizard wrote/read a separate localStorage entry and
// listened on `PENDING_SUBACCOUNTS_CHANGED`. Those callers stay untouched;
// we just route them through the generic store under `kind='create'`.

/** Pending subaccount deployment record persisted between the wizard's
 *  "submit CREATE_CHILD proposal" step and the later "Finalize deployment"
 *  step that runs `executeSetupChild` on the new child. */
export interface PendingSubaccount {
  parentAddress: string;
  childAddress: string;
  childPrivateKey: string;
  childOwners: string[];
  childThreshold: number;
  childName: string;
  proposalHash: string;
  expiryBlock: number | null;
  createdAt: string;
}

/** Reads all pending subaccount records (across all parents) from localStorage. */
export function getPendingSubaccounts(): PendingSubaccount[] {
  return getPendingTxs()
    .filter((r) => r.kind === 'create' && r.childAccount)
    .map((r) => ({
      parentAddress: r.contractAddress,
      childAddress: r.childAccount!.childAddress,
      childPrivateKey: r.childAccount!.childPrivateKey,
      childOwners: r.childAccount!.childOwners,
      childThreshold: r.childAccount!.childThreshold,
      childName: r.childAccount!.childName,
      proposalHash: r.proposalHash,
      expiryBlock: r.childAccount!.expiryBlock,
      createdAt: r.createdAt,
    }));
}

/** Lists pending subaccount records for a single parent address. */
export function getPendingSubaccountsForParent(parentAddress: string): PendingSubaccount[] {
  return getPendingSubaccounts().filter((r) => r.parentAddress === parentAddress);
}

/** Inserts or replaces a pending subaccount record keyed by (parent, child).
 *  Preserves any existing tx hash / signer info already on the matching
 *  PendingTx record (set by `savePendingTx` from the create flow). */
export function savePendingSubaccount(record: PendingSubaccount): void {
  const existing = getPendingTx(record.parentAddress, record.proposalHash, 'create');
  savePendingTx({
    kind: 'create',
    contractAddress: record.parentAddress,
    proposalHash: record.proposalHash,
    txHash: existing?.txHash ?? '',
    signerPubkey: existing?.signerPubkey ?? '',
    createdAt: record.createdAt,
    summary: existing?.summary,
    childAccount: {
      childAddress: record.childAddress,
      childPrivateKey: record.childPrivateKey,
      childOwners: record.childOwners,
      childThreshold: record.childThreshold,
      childName: record.childName,
      expiryBlock: record.expiryBlock,
    },
  });
}

/** Removes any pending subaccount records matching the given parent+child pair. */
export function clearPendingSubaccount(parentAddress: string, childAddress: string): void {
  const matches = getPendingTxsForContract(parentAddress).filter(
    (r) => r.kind === 'create' && r.childAccount?.childAddress === childAddress,
  );
  for (const m of matches) {
    clearPendingTx(m.contractAddress, m.proposalHash, m.kind, m.signerPubkey);
  }
}
