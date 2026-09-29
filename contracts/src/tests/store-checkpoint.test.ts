import { describe, expect, it } from 'bun:test';
import { Field, PrivateKey } from 'o1js';
import { ApprovalStore } from '../storage.js';
import { rebuildStores, type IndexedEvent, type RebuiltStores } from '../event-rebuild.js';
import { checkpointStores, restoreStoreCheckpoint, storesFromOfflineRequest, IncrementalStoreCache, type StoreCheckpoint } from '../store-checkpoint.js';
import { computeOwnerChain } from '../list-commitment.js';

const owner = PrivateKey.fromBigInt(10n).toPublicKey();
const second = PrivateKey.fromBigInt(11n).toPublicKey();
const scope = { network: 'testnet' as const, address: PrivateKey.fromBigInt(12n).toPublicKey().toBase58() };
const history: IndexedEvent[] = [
  { eventType: 'setupOwner', blockHeight: 1, payload: { owner: owner.toBase58(), index: '0' } },
  { eventType: 'proposal', blockHeight: 2, payload: { proposalHash: '100', proposer: owner.toBase58() } },
];
const delta: IndexedEvent = {
  eventType: 'approval', blockHeight: 3,
  payload: { proposalHash: '100', approver: second.toBase58(), approvalCount: '3' },
};
function roots(stores: RebuiltStores) { return checkpointStores(stores, scope, null).roots; }
function harness() {
  let events = [...history];
  let checkpoint: StoreCheckpoint | undefined;
  let current = roots(rebuildStores(events));
  const ranges: (number | undefined)[] = [];
  const source = {
    key: 'endpoint/testnet/vk/vault', scope,
    read: async () => checkpoint,
    write: async (value: StoreCheckpoint) => { checkpoint = value; },
    events: async (from?: number) => { ranges.push(from); return events.filter(e => from === undefined || e.blockHeight! >= from); },
    chain: async () => current,
  };
  return {
    source, ranges, checkpoint: () => checkpoint!,
    setEvents: (next: IndexedEvent[]) => { events = next; current = roots(rebuildStores(next)); },
    corrupt: () => { checkpoint = { ...checkpoint!, nullifiers: '{invalid' }; },
  };
}

describe('verified incremental store checkpoints', () => {
  it('round-trips nullifiers and preserves membership/non-membership witnesses', () => {
    const stores = rebuildStores(history);
    const restored = restoreStoreCheckpoint(checkpointStores(stores, scope, 2), scope);
    expect(roots(restored)).toEqual(roots(stores));
    expect(restored.nullifierStore.isNullified(Field(100), owner)).toBe(true);
    for (const [key, value] of [[Field(100), Field(1)], [Field(101), Field(0)]]) {
      const [root] = restored.nullifierStore.getWitness(key, owner).computeRootAndKey(value);
      expect(root.toString()).toBe(stores.nullifierStore.getRoot().toString());
    }
    expect(() => restoreStoreCheckpoint(checkpointStores(stores, scope, 2), { ...scope, network: 'mainnet' })).toThrow();
    expect(() => restoreStoreCheckpoint(checkpointStores(stores, scope, 2), { ...scope, address: owner.toBase58() })).toThrow();
  });

  it('fetches only newer blocks on warm use and after a cold snapshot restore', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    const first = await cache.get(h.source);
    h.setEvents([...history, delta]);
    const secondResult = await cache.get(h.source);
    expect(h.ranges).toEqual([undefined, 3]);
    expect(roots(secondResult)).toEqual(roots(rebuildStores([...history, delta])));
    expect(first.approvalStore.getCount(Field(100)).toString()).toBe('2');
    const cold = await new IncrementalStoreCache().get(h.source);
    expect(h.ranges).toEqual([undefined, 3, 4]);
    expect(roots(cold)).toEqual(roots(secondResult));
  });

  it('does not rehash historical leaves on a warm request', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    await cache.get(h.source);
    const original = ApprovalStore.deserialize;
    ApprovalStore.deserialize = () => { throw new Error('unexpected history restore'); };
    try {
      h.setEvents([...history, delta]);
      expect(roots(await cache.get(h.source))).toEqual(roots(rebuildStores([...history, delta])));
      expect(h.ranges).toEqual([undefined, 3]);
    } finally { ApprovalStore.deserialize = original; }
  });

  it('replays owner changes against the checkpoint order', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    await cache.get(h.source);
    const change: IndexedEvent = {
      eventType: 'ownerChange', blockHeight: 3,
      payload: { configNonce: '1', owner: second.toBase58(), added: '1', newOwnersCommitment: computeOwnerChain([second, owner]).toString() },
    };
    h.setEvents([...history, change]);
    const stores = await cache.get(h.source);
    expect(stores.ownerStore.owners.map(x => x.toBase58())).toEqual([second, owner].map(x => x.toBase58()));
    expect(h.ranges).toEqual([undefined, 3]);
  });

  it('recovers from a reorg with one full replay', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    await cache.get(h.source);
    h.setEvents(history.slice(0, 1));
    expect(roots(await cache.get(h.source))).toEqual(roots(rebuildStores(history.slice(0, 1))));
    expect(h.ranges).toEqual([undefined, 3, undefined]);
  });

  it('replays a late event in the checkpoint block after detecting a mismatch', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    await cache.get(h.source);
    h.setEvents([...history, { ...delta, blockHeight: 2 }]);
    await cache.get(h.source);
    expect(h.ranges).toEqual([undefined, 3, undefined]);
  });

  it('treats corrupt persisted data as a cache miss', async () => {
    const h = harness();
    await new IncrementalStoreCache().get(h.source);
    h.corrupt();
    await new IncrementalStoreCache().get(h.source);
    expect(h.ranges).toEqual([undefined, undefined]);
  });

  it('fails closed if a full replay still disagrees with chain state', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    await cache.get(h.source);
    h.source.chain = async () => ({ ...roots(rebuildStores(history)), voteNullifierRoot: '1' });
    await expect(cache.get(h.source)).rejects.toThrow('on-chain nullifier root');
    expect(h.ranges).toEqual([undefined, 3, undefined]);
  });

  it('does not checkpoint a failed page or unavailable chain state', async () => {
    const h = harness();
    h.source.events = async () => { throw new Error('page failed'); };
    await expect(new IncrementalStoreCache().get(h.source)).rejects.toThrow('page failed');
    expect(h.checkpoint()).toBeUndefined();
  });

  it('works with unavailable persistent storage and does not increment legacy unknown heights', async () => {
    const h = harness();
    h.setEvents(history.map(e => ({ ...e, blockHeight: null })));
    h.source.write = async () => { throw new Error('quota exceeded'); };
    const cache = new IncrementalStoreCache();
    await cache.get(h.source);
    await cache.get(h.source);
    expect(h.ranges).toEqual([undefined, undefined]);
  });

  it('isolates concurrently returned stores and does not poison the cache when a caller mutates them', async () => {
    const h = harness();
    const cache = new IncrementalStoreCache();
    const [a, b] = await Promise.all([cache.get(h.source), cache.get(h.source)]);
    a.approvalStore.setCount(Field(100), Field(50));
    a.nullifierStore.nullify(Field(101), owner);
    a.ownerStore.owners = [];
    expect(roots(b)).toEqual(roots(rebuildStores(history)));
    expect(roots(await cache.get(h.source))).toEqual(roots(b));
  });

  it('accepts legacy v1 and snapshot v2, rejects incompatible or inconsistent requests', () => {
    const stores = rebuildStores(history);
    const request = { version: 1, minaNetwork: scope.network, contractAddress: scope.address, events: history };
    expect(roots(storesFromOfflineRequest(request, roots(stores)))).toEqual(roots(stores));
    const v2 = { ...request, version: 2, events: [], storeCheckpoint: checkpointStores(stores, scope, null) };
    expect(roots(storesFromOfflineRequest(v2, roots(stores)))).toEqual(roots(stores));
    for (const invalid of [ { ...v2, version: 3 }, { ...v2, version: 1 }, { ...v2, storeCheckpoint: undefined }, { ...v2, events: history } ]) {
      expect(() => storesFromOfflineRequest(invalid, roots(stores))).toThrow();
    }
    expect(() => storesFromOfflineRequest(v2, { ...roots(stores), approvalRoot: '1' })).toThrow();
    expect(() => storesFromOfflineRequest(v2, {})).toThrow();
    const modified = { ...v2, storeCheckpoint: { ...v2.storeCheckpoint, nullifiers: '{"keys":[]}' } };
    expect(() => storesFromOfflineRequest(modified, roots(stores))).toThrow();
  });
});
