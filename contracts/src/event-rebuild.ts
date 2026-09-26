import { Field, MerkleMap, PublicKey } from 'o1js';
import { ApprovalStore, OwnerStore, VoteNullifierStore } from './storage.js';
import { EXECUTED_MARKER, PROPOSED_MARKER, TxType } from './constants.js';

/**
 * Rebuilds a guard's off-chain stores from its indexed events. Shared by the
 * web worker and the offline CLI so both clients reconstruct state the same way.
 *
 * The result does not depend on event delivery order:
 * - approval leaves only ever grow (proposed < approval counts < executed), so
 *   each leaf keeps the largest value seen; nullifier writes are idempotent;
 * - owners come from the emitted setup slot index, and owner changes are
 *   replayed in configNonce order, each insert placed where the emitted
 *   post-change commitment says it went.
 *
 * Events are unauthenticated (anyone can append events to a vault), so the
 * rebuilt stores must be checked against on-chain state before use; see
 * assertStoresMatchChain.
 */

/** An indexed event as served by the backend (payload values are strings). */
export interface IndexedEvent {
  eventType: string;
  payload: unknown;
  /** Inclusion block; enables per-block checkpoint diagnostics when present. */
  blockHeight?: number | null;
}

export interface RebuiltStores {
  ownerStore: OwnerStore;
  approvalStore: ApprovalStore;
  nullifierStore: VoteNullifierStore;
  /** First block whose emitted roots disagree with the rebuild, or null. */
  firstDivergentBlock: { approval: number | null; nullifier: number | null };
}

/** On-chain values the rebuild must reproduce (decimal strings or Fields). */
export interface ChainState {
  ownersCommitment?: string | Field | null;
  approvalRoot?: string | Field | null;
  voteNullifierRoot?: string | Field | null;
}

// REMOTE lifecycle executions write the child's childExecutionRoot, not approvalRoot.
const REMOTE_EXECUTION_TYPES = new Set(
  [TxType.CREATE_CHILD, TxType.RECLAIM_CHILD, TxType.DESTROY_CHILD, TxType.ENABLE_CHILD_MULTI_SIG]
    .map((t) => t.toString()),
);
const CHILD_EXECUTION_MARKING_TYPES = new Set(
  [TxType.RECLAIM_CHILD, TxType.DESTROY_CHILD, TxType.ENABLE_CHILD_MULTI_SIG].map((t) => t.toString()),
);

function field(payload: unknown, key: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  return null;
}

function publicKey(payload: unknown, key: string): PublicKey | null {
  const value = field(payload, key);
  if (!value || value.length <= 10) return null;
  try {
    return PublicKey.fromBase58(value);
  } catch {
    return null; // PublicKey.empty() and malformed keys do not decode
  }
}

function isExecution(e: IndexedEvent): boolean {
  return e.eventType === 'execution' || e.eventType === 'executionBatch';
}

// -- owners ------------------------------------------------------------------

function rebuildOwners(events: readonly IndexedEvent[], initial?: OwnerStore): OwnerStore {
  const store = new OwnerStore();
  if (initial) store.owners = [...initial.owners];

  const slots = new Map<number, PublicKey>();
  const unindexed: PublicKey[] = [];
  for (const e of events) {
    if (initial || e.eventType !== 'setupOwner') continue;
    const owner = publicKey(e.payload, 'owner');
    if (!owner) continue;
    const index = field(e.payload, 'index');
    if (index === null) unindexed.push(owner);
    else if (!slots.has(Number(index))) slots.set(Number(index), owner);
  }
  if (slots.size > 0) {
    store.owners = [...slots.entries()].sort(([a], [b]) => a - b).map(([, pk]) => pk);
  } else {
    for (const owner of unindexed) store.addSorted(owner); // legacy events without an index
  }

  // Each owner change bumps configNonce, which gives the true replay order.
  const changes = new Map<string, IndexedEvent>();
  for (const e of events) {
    if (e.eventType !== 'ownerChange' && e.eventType !== 'ownerChangeBatch') continue;
    const key = [field(e.payload, 'configNonce'), field(e.payload, 'owner'), field(e.payload, 'added')].join('|');
    if (!changes.has(key)) changes.set(key, e);
  }
  const nonceOf = (e: IndexedEvent) => {
    const n = Number(field(e.payload, 'configNonce'));
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; // unknown nonce: replay last
  };
  const ordered = [...changes.values()].sort((a, b) => nonceOf(a) - nonceOf(b));

  for (const e of ordered) {
    const owner = publicKey(e.payload, 'owner');
    if (!owner) continue;
    const added = field(e.payload, 'added');
    const isAdd = added === '1' || (e.payload as Record<string, unknown>)?.added === true;
    if (!isAdd) {
      store.remove(owner);
      continue;
    }
    const target = field(e.payload, 'newOwnersCommitment');
    const position = target === null ? -1 : store.insertPositionFor(owner, target);
    if (position < 0) store.addSorted(owner); // no commitment to match: fall back to the canonical order
    else store.owners.splice(position, 0, owner);
  }
  return store;
}

// -- approval and nullifier maps ----------------------------------------------

function raiseTo(store: ApprovalStore, proposalHash: Field, value: Field): void {
  if (value.toBigInt() > store.getCount(proposalHash).toBigInt()) store.setCount(proposalHash, value);
}

function applyMapEvent(e: IndexedEvent, approvals: ApprovalStore, nullifiers: VoteNullifierStore): void {
  const hash = field(e.payload, 'proposalHash');
  if (hash === null) return;
  const proposalHash = Field(hash);

  if (e.eventType === 'proposal' || e.eventType === 'approval') {
    const count = e.eventType === 'proposal' ? PROPOSED_MARKER.add(1) : Field(field(e.payload, 'approvalCount') ?? '0');
    raiseTo(approvals, proposalHash, count);
    const voter = publicKey(e.payload, e.eventType === 'proposal' ? 'proposer' : 'approver');
    if (voter) nullifiers.nullify(proposalHash, voter);
    return;
  }
  if (isExecution(e) && !REMOTE_EXECUTION_TYPES.has(field(e.payload, 'txType') ?? '')) {
    raiseTo(approvals, proposalHash, EXECUTED_MARKER);
  }
}

/** Roots the contract emitted in one block, per map (checkpoints). */
function emittedRoots(block: readonly IndexedEvent[]): { approval: Set<string>; nullifier: Set<string> } {
  const approval = new Set<string>();
  const nullifier = new Set<string>();
  for (const e of block) {
    if (e.eventType === 'approval') {
      const a = field(e.payload, 'approvalRoot');
      const n = field(e.payload, 'voteNullifierRoot');
      if (a) approval.add(a);
      if (n) nullifier.add(n);
    } else if (isExecution(e) && !REMOTE_EXECUTION_TYPES.has(field(e.payload, 'txType') ?? '')) {
      const r = field(e.payload, 'root');
      if (r) approval.add(r);
    }
  }
  return { approval, nullifier };
}

/** Rebuilds stores, or applies a strictly later event range to caller-owned initial stores.
 * Callers supplying initial stores must exclude the already-applied block range.
 */
export function rebuildStores(events: readonly IndexedEvent[], initial?: RebuiltStores): RebuiltStores {
  const ownerStore = rebuildOwners(events, initial?.ownerStore);
  const approvalStore = initial?.approvalStore ?? new ApprovalStore();
  const nullifierStore = initial?.nullifierStore ?? new VoteNullifierStore();
  const firstDivergentBlock: RebuiltStores['firstDivergentBlock'] = { approval: null, nullifier: null };

  const unplaced: IndexedEvent[] = [];
  const blocks = new Map<number, IndexedEvent[]>();
  for (const e of events) {
    if (typeof e.blockHeight === 'number') {
      const list = blocks.get(e.blockHeight) ?? [];
      list.push(e);
      blocks.set(e.blockHeight, list);
    } else {
      unplaced.push(e);
    }
  }
  for (const e of unplaced) applyMapEvent(e, approvalStore, nullifierStore);

  // The fold commutes, so the state after a whole block is order-independent and
  // must equal the root emitted by that block's last write to each map.
  const checkpointsUsable = unplaced.length === 0;
  for (const height of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(height)!;
    for (const e of block) applyMapEvent(e, approvalStore, nullifierStore);
    if (!checkpointsUsable) continue;
    const roots = emittedRoots(block);
    if (firstDivergentBlock.approval === null && roots.approval.size > 0
      && !roots.approval.has(approvalStore.getRoot().toString())) {
      firstDivergentBlock.approval = height;
    }
    if (firstDivergentBlock.nullifier === null && roots.nullifier.size > 0
      && !roots.nullifier.has(nullifierStore.getRoot().toString())) {
      firstDivergentBlock.nullifier = height;
    }
  }

  return { ownerStore, approvalStore, nullifierStore, firstDivergentBlock };
}

/** Rebuilds a child's childExecutionRoot map from its own events. */
export function rebuildChildExecutionMap(events: readonly IndexedEvent[]): MerkleMap {
  const map = new MerkleMap();
  for (const e of events) {
    if (!isExecution(e)) continue;
    const hash = field(e.payload, 'proposalHash');
    if (hash === null || !CHILD_EXECUTION_MARKING_TYPES.has(field(e.payload, 'txType') ?? '')) continue;
    map.set(Field(hash), EXECUTED_MARKER);
  }
  return map;
}

// -- verification ------------------------------------------------------------

function sameValue(a: string | Field, b: Field): boolean {
  return (typeof a === 'string' ? a : a.toString()) === b.toString();
}

function at(block: number | null): string {
  return block === null ? '' : ` (first divergence at block ${block})`;
}

/**
 * Throws unless the rebuilt stores reproduce the on-chain state. A mismatch
 * means the event source is behind, incomplete or polluted; proving against
 * such stores could only fail, so callers refuse early with this message.
 */
export function assertStoresMatchChain(stores: RebuiltStores, chain: ChainState, label = 'vault'): void {
  const retry = 'The indexed events do not reproduce this state yet; wait for the indexer to catch up and retry.';
  if (chain.ownersCommitment != null && !sameValue(chain.ownersCommitment, stores.ownerStore.getCommitment())) {
    throw new Error(`Rebuilt owner list does not match the ${label}'s on-chain owner commitment. ${retry}`);
  }
  if (chain.approvalRoot != null && !sameValue(chain.approvalRoot, stores.approvalStore.getRoot())) {
    throw new Error(
      `Rebuilt approval map does not match the ${label}'s on-chain approval root${at(stores.firstDivergentBlock.approval)}. ${retry}`,
    );
  }
  if (chain.voteNullifierRoot != null && !sameValue(chain.voteNullifierRoot, stores.nullifierStore.getRoot())) {
    throw new Error(
      `Rebuilt vote nullifier map does not match the ${label}'s on-chain nullifier root${at(stores.firstDivergentBlock.nullifier)}. ${retry}`,
    );
  }
}

/** Throws unless the rebuilt child execution map reproduces the child's on-chain root. */
export function assertChildExecutionMapMatchesChain(map: MerkleMap, chainRoot: string | Field | null | undefined): void {
  if (chainRoot != null && !sameValue(chainRoot, map.getRoot())) {
    throw new Error(
      "Rebuilt child execution map does not match the SubVault's on-chain root. " +
      'The indexed events do not reproduce this state yet; wait for the indexer to catch up and retry.',
    );
  }
}
