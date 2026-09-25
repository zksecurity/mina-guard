import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, UInt32, UInt64 } from 'o1js';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MinaGuard, Receiver, SetupOwnersInput } from '../MinaGuard.js';
import { EXECUTED_MARKER, TxType } from '../constants.js';
import { PublicKeyOption, computeOwnerChain } from '../list-commitment.js';
import {
  assertStoresMatchChain,
  rebuildChildExecutionMap,
  rebuildStores,
  type IndexedEvent,
} from '../event-rebuild.js';
import {
  approveTransaction,
  createAddOwnerProposal,
  createTransferProposal,
  deployAndSetup,
  fundAccount,
  makeOwnerWitness,
  proposeTransaction,
  setupLocalBlockchain,
  toFixedSetupOwners,
  type TestContext,
} from './test-helpers.js';

/** Mirrors the backend's payload encoding: keys as base58, everything else as strings. */
function serialize(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as { toBase58?: () => string; toString: () => string };
    if (typeof v.toBase58 === 'function') return v.toBase58();
    return v.toString();
  }
  return value;
}

async function indexedEvents(zkApp: MinaGuard): Promise<IndexedEvent[]> {
  const raw = await zkApp.fetchEvents();
  return raw.map((e) => ({
    eventType: e.type,
    blockHeight: Number(e.blockHeight.toString()),
    payload: Object.fromEntries(
      Object.entries(e.event.data as unknown as Record<string, unknown>).map(([k, v]) => [k, serialize(v)]),
    ),
  }));
}

function chainState(zkApp: MinaGuard) {
  return {
    ownersCommitment: zkApp.ownersCommitment.get(),
    approvalRoot: zkApp.approvalRoot.get(),
    voteNullifierRoot: zkApp.voteNullifierRoot.get(),
  };
}

/** Deterministic Fisher-Yates so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

let height = 0;
/** Each transaction lands in its own block so checkpoints can be located. */
function nextBlock() {
  height += 1;
  (Mina.activeInstance as unknown as { setBlockchainLength(h: UInt32): void }).setBlockchainLength(UInt32.from(height));
}

async function executeTransfer(ctx: TestContext, proposal: ReturnType<typeof createTransferProposal>) {
  const hash = proposal.hash();
  const txn = await Mina.transaction(ctx.deployerAccount, async () => {
    await ctx.zkApp.executeTransfer(proposal, ctx.approvalStore.getWitness(hash), ctx.approvalStore.getCount(hash));
  });
  await txn.prove();
  await txn.sign([ctx.deployerKey]).send();
  ctx.approvalStore.setCount(hash, EXECUTED_MARKER);
}

describe('rebuildStores', () => {
  let ctx: TestContext;
  let recipient: PublicKey;

  beforeEach(async () => {
    height = 0;
    ctx = await setupLocalBlockchain();
    nextBlock();
    await deployAndSetup(ctx, 2);
    recipient = PrivateKey.random().toPublicKey();
    nextBlock();
    await fundAccount(ctx, recipient);
  });

  /** Proposal A: proposed, approved, executed. Proposal B: proposed, approved. */
  async function runLifecycle() {
    const transfer = (nonce: number) =>
      createTransferProposal([new Receiver({ address: recipient, amount: UInt64.from(1_000) })], Field(nonce), Field(0), ctx.zkAppAddress);
    const a = transfer(1);
    const b = transfer(2);
    nextBlock(); await proposeTransaction(ctx, a, 0);
    nextBlock(); await approveTransaction(ctx, a, 1);
    nextBlock(); await executeTransfer(ctx, a);
    nextBlock(); await proposeTransaction(ctx, b, 0);
    nextBlock(); await approveTransaction(ctx, b, 1);
    return { a, b };
  }

  it('reproduces the on-chain owners, approval root and nullifier root', async () => {
    await runLifecycle();
    const stores = rebuildStores(await indexedEvents(ctx.zkApp));
    assertStoresMatchChain(stores, chainState(ctx.zkApp));
    expect(stores.firstDivergentBlock).toEqual({ approval: null, nullifier: null });
  });

  it('does not depend on delivery order or duplicates', async () => {
    await runLifecycle();
    const events = await indexedEvents(ctx.zkApp);
    for (const variant of [[...events].reverse(), shuffled(events, 7), shuffled([...events, ...events.slice(0, 9)], 3)]) {
      const stores = rebuildStores(variant);
      assertStoresMatchChain(stores, chainState(ctx.zkApp));
      expect(stores.firstDivergentBlock).toEqual({ approval: null, nullifier: null });
    }
  });

  it('keeps an executed leaf when its approval arrives after the execution', async () => {
    const { a } = await runLifecycle();
    const events = await indexedEvents(ctx.zkApp);
    const hash = a.hash().toString();
    const isLateApproval = (e: IndexedEvent) =>
      e.eventType === 'approval' && (e.payload as Record<string, string>).proposalHash === hash
      && (e.payload as Record<string, string>).approvalCount === '3';
    const reordered = [...events.filter((e) => !isLateApproval(e)), ...events.filter(isLateApproval)];
    const stores = rebuildStores(reordered.map(({ blockHeight, ...rest }) => rest)); // no heights: plain fold
    expect(stores.approvalStore.getCount(a.hash())).toEqual(EXECUTED_MARKER);
    assertStoresMatchChain(stores, chainState(ctx.zkApp));
  });

  it('refuses a rebuild with a missing event and names the first divergent checkpoint', async () => {
    const { a } = await runLifecycle();
    const hash = a.hash().toString();
    const events = (await indexedEvents(ctx.zkApp)).filter(
      (e) => !(e.eventType === 'approval' && (e.payload as Record<string, string>).proposalHash === hash
        && (e.payload as Record<string, string>).approvalCount === '3'),
    );
    const stores = rebuildStores(events);
    // The approval leaf still ends executed; the missing approver nullifier shows at the next nullifier write (B's propose).
    expect(stores.firstDivergentBlock.approval).toBeNull();
    expect(stores.firstDivergentBlock.nullifier).toBe(6);
    expect(() => assertStoresMatchChain(stores, chainState(ctx.zkApp))).toThrow(
      /nullifier root \(first divergence at block 6\)/,
    );
  });
});

describe('rebuildStores owner order', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
  });

  it('follows the emitted slot index, not base58 order', async () => {
    const reversed = ctx.owners.map((o) => o.pub).reverse();
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      AccountUpdate.fundNewAccount(ctx.deployerAccount);
      await ctx.zkApp.deploy();
      await ctx.zkApp.setup(Field(2), Field(reversed.length), new SetupOwnersInput({ owners: toFixedSetupOwners(reversed) }));
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey, ctx.zkAppKey]).send();

    const stores = rebuildStores(await indexedEvents(ctx.zkApp));
    expect(stores.ownerStore.owners.map((pk) => pk.toBase58())).toEqual(reversed.map((pk) => pk.toBase58()));
    assertStoresMatchChain(stores, chainState(ctx.zkApp));
    // sorting, what the clients did before, cannot reproduce this commitment
    const sorted = [...reversed].sort((x, y) => (x.toBase58() > y.toBase58() ? 1 : -1));
    expect(computeOwnerChain(sorted)).not.toEqual(ctx.zkApp.ownersCommitment.get());
  });

  it('places an added owner where the emitted commitment says, even off the canonical position', async () => {
    await deployAndSetup(ctx, 2);
    const owners = ctx.owners.map((o) => o.pub);
    const newOwner = PrivateKey.random().toPublicKey();
    const canonical = [...owners, newOwner].sort((x, y) => (x.toBase58() > y.toBase58() ? 1 : -1));
    // pick a position that is not the canonical one
    const canonicalIndex = canonical.findIndex((pk) => pk.equals(newOwner).toBoolean());
    const position = canonicalIndex === 0 ? owners.length : 0;
    const placed = [...owners.slice(0, position), newOwner, ...owners.slice(position)];

    const proposal = createAddOwnerProposal(newOwner, owners, Field(1), Field(0), ctx.zkAppAddress);
    proposal.data = computeOwnerChain(placed);
    await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);
    const insertAfter = position === 0
      ? PublicKeyOption.none()
      : PublicKeyOption.from(owners[position - 1]);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeOwnerChange(
        proposal, ctx.approvalStore.getWitness(proposal.hash()), Field(3), makeOwnerWitness(owners), insertAfter,
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    const stores = rebuildStores(await indexedEvents(ctx.zkApp));
    expect(stores.ownerStore.owners.map((pk) => pk.toBase58())).toEqual(placed.map((pk) => pk.toBase58()));
    assertStoresMatchChain(stores, chainState(ctx.zkApp));
  });
});

describe('rebuildChildExecutionMap', () => {
  it('marks REMOTE lifecycle executions only', () => {
    const execution = (hash: string, txType: Field) => ({ eventType: 'execution', payload: { proposalHash: hash, txType: txType.toString() } });
    const map = rebuildChildExecutionMap([
      execution('11', TxType.RECLAIM_CHILD),
      execution('12', TxType.TRANSFER),
      execution('13', TxType.CREATE_CHILD),
      execution('14', TxType.DESTROY_CHILD),
    ]);
    expect(map.get(Field(11))).toEqual(EXECUTED_MARKER);
    expect(map.get(Field(12))).toEqual(Field(0));
    expect(map.get(Field(13))).toEqual(Field(0));
    expect(map.get(Field(14))).toEqual(EXECUTED_MARKER);
  });
});
