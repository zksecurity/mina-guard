import { ApprovalStore, OwnerStore, VoteNullifierStore } from './storage.js';
import { MAX_OWNERS } from './constants.js';
import { assertStoresMatchChain, rebuildStores, type ChainState, type IndexedEvent, type RebuiltStores } from './event-rebuild.js';

/** Public reconstruction data only. Never includes keys or signing material. */
export interface StoreCheckpoint {
  version: 1;
  network: 'mainnet' | 'testnet';
  address: string;
  /** Last completely fetched event block; null for legacy events without heights. */
  throughBlock: number | null;
  owners: string;
  approvals: string;
  nullifiers: string;
  roots: { ownersCommitment: string; approvalRoot: string; voteNullifierRoot: string };
}

export interface StoreScope {
  network: 'mainnet' | 'testnet';
  address: string;
}

function requireRoots(chain: ChainState): void {
  if (chain.ownersCommitment == null || chain.approvalRoot == null || chain.voteNullifierRoot == null) {
    throw new Error('A complete account state is required to verify a store checkpoint');
  }
}

export function checkpointStores(stores: RebuiltStores, scope: StoreScope, throughBlock: number | null): StoreCheckpoint {
  return {
    version: 1, ...scope, throughBlock,
    owners: stores.ownerStore.serialize(),
    approvals: stores.approvalStore.serialize(),
    nullifiers: stores.nullifierStore.serialize(),
    roots: {
      ownersCommitment: stores.ownerStore.getCommitment().toString(),
      approvalRoot: stores.approvalStore.getRoot().toString(),
      voteNullifierRoot: stores.nullifierStore.getRoot().toString(),
    },
  };
}

/** Recompute trees from leaves, never trust serialized internal nodes or roots. */
export function restoreStoreCheckpoint(checkpoint: StoreCheckpoint, scope: StoreScope): RebuiltStores {
  if (!checkpoint || checkpoint.version !== 1 || checkpoint.network !== scope.network || checkpoint.address !== scope.address
    || (checkpoint.throughBlock !== null && (!Number.isSafeInteger(checkpoint.throughBlock) || checkpoint.throughBlock < 0))
    || typeof checkpoint.owners !== 'string' || typeof checkpoint.approvals !== 'string' || typeof checkpoint.nullifiers !== 'string') {
    throw new Error('Invalid or incompatible store checkpoint');
  }
  const owners = JSON.parse(checkpoint.owners);
  if (!Array.isArray(owners.owners) || owners.owners.length > MAX_OWNERS) throw new Error('Invalid checkpoint owners');
  requireRoots(checkpoint.roots ?? {});
  const stores: RebuiltStores = {
    ownerStore: OwnerStore.deserialize(checkpoint.owners),
    approvalStore: ApprovalStore.deserialize(checkpoint.approvals),
    nullifierStore: VoteNullifierStore.deserialize(checkpoint.nullifiers),
    firstDivergentBlock: { approval: null, nullifier: null },
  };
  assertStoresMatchChain(stores, checkpoint.roots);
  return stores;
}

/** v1 requests retain full event replay; v2 requests carry a complete snapshot. */
export function storesFromOfflineRequest(request: {
  version: number; minaNetwork: 'mainnet' | 'testnet'; contractAddress: string;
  events: readonly IndexedEvent[]; storeCheckpoint?: StoreCheckpoint;
}, chain: ChainState): RebuiltStores {
  requireRoots(chain);
  let stores: RebuiltStores;
  if (request.version === 1) {
    if (request.storeCheckpoint !== undefined) throw new Error('Checkpoints require offline request version 2');
    stores = rebuildStores(request.events);
  } else if (request.version === 2) {
    if (!request.storeCheckpoint || !Array.isArray(request.events) || request.events.length !== 0) {
      throw new Error('Offline request version 2 requires a complete store checkpoint and empty events');
    }
    stores = restoreStoreCheckpoint(request.storeCheckpoint, { network: request.minaNetwork, address: request.contractAddress });
  } else {
    throw new Error(`Unsupported bundle version: ${request.version}`);
  }
  // Offline account snapshots are supplied by the online machine. As before,
  // the actual ledger must satisfy the transaction's state preconditions.
  assertStoresMatchChain(stores, chain);
  return stores;
}

function cloneStores(stores: RebuiltStores): RebuiltStores {
  const ownerStore = new OwnerStore();
  ownerStore.owners = [...stores.ownerStore.owners];
  const approvalStore = new ApprovalStore();
  approvalStore.map.tree = stores.approvalStore.map.tree.clone();
  approvalStore.keys = [...stores.approvalStore.keys];
  return {
    ownerStore, approvalStore, nullifierStore: stores.nullifierStore.clone(),
    firstDivergentBlock: { ...stores.firstDivergentBlock },
  };
}

interface CachedStores { stores: RebuiltStores; throughBlock: number | null }
export interface CheckpointSource {
  /** Also bind endpoint and circuit identity in this key. */
  key: string;
  scope: StoreScope;
  read(): Promise<StoreCheckpoint | undefined>;
  write(checkpoint: StoreCheckpoint): Promise<void>;
  /** Fetch all pages; reject failed/truncated reads. fromBlock is inclusive. */
  events(fromBlock?: number): Promise<IndexedEvent[]>;
  chain(): Promise<ChainState>;
}

/** Bounded in-memory cache; persistent snapshots are optional and untrusted. */
export class IncrementalStoreCache {
  private cache = new Map<string, CachedStores>();
  private pending = new Map<string, Promise<unknown>>();

  async get(source: CheckpointSource): Promise<RebuiltStores> {
    // Serialize updates for this vault. Returned stores are independent copies
    // so another request cannot mutate witnesses while a signer is reviewing.
    const previous = this.pending.get(source.key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => this.load(source));
    this.pending.set(source.key, result);
    try { return await result; }
    finally { if (this.pending.get(source.key) === result) this.pending.delete(source.key); }
  }

  private async load(source: CheckpointSource): Promise<RebuiltStores> {
    let cached = this.cache.get(source.key);
    if (!cached) {
      try {
        const checkpoint = await source.read();
        if (checkpoint) cached = { stores: restoreStoreCheckpoint(checkpoint, source.scope), throughBlock: checkpoint.throughBlock };
      } catch { /* Corrupt/unavailable persistence is a cache miss. */ }
    }
    const incremental = cached && cached.throughBlock !== null;
    for (const useCache of incremental ? [true, false] : [false]) {
      try {
        const fromBlock = useCache ? cached!.throughBlock! + 1 : undefined;
        const events = await source.events(fromBlock);
        if (useCache && events.some(e => !Number.isSafeInteger(e.blockHeight) || e.blockHeight! < fromBlock!)) {
          throw new Error('Event source returned an invalid incremental range');
        }
        const stores = rebuildStores(events, useCache ? cloneStores(cached!.stores) : undefined);
        const chain = await source.chain();
        requireRoots(chain);
        assertStoresMatchChain(stores, chain);
        let throughBlock: number | null = useCache ? cached!.throughBlock : null;
        for (const e of events) {
          if (!Number.isSafeInteger(e.blockHeight) || e.blockHeight! < 0) { throughBlock = null; break; }
          throughBlock = Math.max(throughBlock ?? 0, e.blockHeight!);
        }
        this.cache.delete(source.key);
        this.cache.set(source.key, { stores, throughBlock });
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
        try { await source.write(checkpointStores(stores, source.scope, throughBlock)); }
        catch { /* Quota/storage failures must not prevent verified operations. */ }
        return cloneStores(stores);
      } catch (error) {
        this.cache.delete(source.key);
        if (!useCache) throw error;
        // Reorg, cursor drift, missing late events or corruption: retry once
        // from genesis. A second mismatch fails closed before signing/proving.
      }
    }
    throw new Error('Store reconstruction failed');
  }
}
