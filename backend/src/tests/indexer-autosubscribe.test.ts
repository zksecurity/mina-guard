import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import { MinaGuardIndexer } from '../indexer.js';
import * as minaClient from '../mina-client.js';

const liteConfig = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
  archiveEndpoint: 'http://stub',
  archiveFallbackEndpoint: null,
  indexPollIntervalMs: 1000,
  indexStartHeight: 0,
  minaguardVkHash: null,
  lightnetAccountManager: null,
  indexerMode: 'lite' as const,
} as unknown as BackendConfig;

const fullConfig = { ...liteConfig, indexerMode: 'full' as const } as BackendConfig;

async function clearAll() {
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.blockHeader.deleteMany();
  await prisma.indexerCursor.deleteMany();
}

async function setCursor(height: number) {
  await prisma.indexerCursor.upsert({
    where: { key: 'indexed_height' },
    create: { key: 'indexed_height', value: String(height) },
    update: { value: String(height) },
  });
}

beforeEach(async () => {
  await clearAll();
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe('backfillContract window', () => {
  test('lite mode backfills from config.indexStartHeight', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({ data: { address, ready: false } });
    await setCursor(1000);

    const calls: Array<{ from: number; to: number }> = [];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async (
        _addr: string,
        from: number,
        to: number,
      ) => {
        calls.push({ from, to });
        return [];
      },
    }));

    const indexer = new MinaGuardIndexer(liteConfig);
    await indexer.backfillContract(contract.id, address);

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe(0);
    expect(calls[0].to).toBe(1000);
  });

  test('full mode backfills from indexedHeight - 300', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({ data: { address, ready: false } });
    await setCursor(1000);

    const calls: Array<{ from: number; to: number }> = [];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async (
        _addr: string,
        from: number,
        to: number,
      ) => {
        calls.push({ from, to });
        return [];
      },
    }));

    const indexer = new MinaGuardIndexer(fullConfig);
    await indexer.backfillContract(contract.id, address);

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe(700);
    expect(calls[0].to).toBe(1000);
  });

  test('leaves ready=false when backfill ingested no events (subscribe-before-deploy)', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({ data: { address, ready: false } });
    await setCursor(500);

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async () => [],
    }));

    const indexer = new MinaGuardIndexer(liteConfig);
    await indexer.backfillContract(contract.id, address);

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.ready).toBe(false);
  });

  test('flips ready=true when backfill ingests at least one event', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({ data: { address, ready: false } });
    await setCursor(100);

    // Any MinaGuard event is proof the contract was initialized on-chain.
    // Use an execution event because it's the simplest to stub without
    // triggering the deeper setup/ownerChange/etc. state machinery.
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async () => [makeExecutionEvent('hash-x', 50)],
    }));

    const indexer = new MinaGuardIndexer(liteConfig);
    await indexer.backfillContract(contract.id, address);

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.ready).toBe(true);
  });

  test('does not touch ready when nothing to backfill (indexedHeight <= backfillFrom)', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({ data: { address, ready: false } });
    // indexedHeight == 0 == indexStartHeight, so no network call and no
    // sync should run; readiness stays at its inserted value.
    await setCursor(0);

    let called = false;
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async () => {
        called = true;
        return [];
      },
    }));

    const indexer = new MinaGuardIndexer(liteConfig);
    await indexer.backfillContract(contract.id, address);

    expect(called).toBe(false);
    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.ready).toBe(false);
  });
});

describe('maybeAutoSubscribeChild via applyExecutionEvent', () => {
  async function seedParentWithCreateChildProposal(
    parentAddress: string,
    proposalHash: string,
    childAddress: string,
  ) {
    const parent = await prisma.contract.create({
      data: { address: parentAddress, ready: true },
    });
    await prisma.proposal.create({
      data: {
        contractId: parent.id,
        proposalHash,
        txType: '5',
        childAccount: childAddress,
        createdAtBlock: 10,
      },
    });
    return parent;
  }

  test('lite mode: auto-subscribes child on CREATE_CHILD execution', async () => {
    const parentAddress = PrivateKey.random().toPublicKey().toBase58();
    const childAddress = PrivateKey.random().toPublicKey().toBase58();
    const proposalHash = '42';
    await seedParentWithCreateChildProposal(parentAddress, proposalHash, childAddress);
    await setCursor(100);

    // Two calls to fetchDecodedContractEvents are expected during the test:
    // 1) parent sync (returns the execution event)
    // 2) child auto-subscribe's backfillContract (no events to return)
    const eventsByAddress: Record<string, Array<ReturnType<typeof makeExecutionEvent>>> = {
      [parentAddress]: [makeExecutionEvent(proposalHash, 20)],
      [childAddress]: [],
    };
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async (addr: string) => eventsByAddress[addr] ?? [],
    }));

    const indexer = new MinaGuardIndexer(liteConfig);
    // Drive via the parent's backfill — this runs syncSingleContract, which
    // processes the execution event and triggers maybeAutoSubscribeChild.
    const parent = await prisma.contract.findUniqueOrThrow({ where: { address: parentAddress } });
    await indexer.backfillContract(parent.id, parentAddress);

    const child = await prisma.contract.findUnique({ where: { address: childAddress } });
    expect(child).not.toBeNull();
    expect(child?.parent).toBe(parentAddress);
    // discoveredAtBlock is the execution-event block height (the child's
    // own events land in the same block on-chain), so the unready rescan
    // will re-scan from there.
    expect(child?.discoveredAtBlock).toBe(20);
    // ready stays false because this mock returns no events for the child
    // address. In production the child emits its own setup/setupOwner
    // events in the same tx as the parent's execution; the unready-rescan
    // path will flip ready=true on the next tick once the child's events
    // are fetched and ingested.
    expect(child?.ready).toBe(false);
  });

  test('full mode: does NOT auto-subscribe', async () => {
    const parentAddress = PrivateKey.random().toPublicKey().toBase58();
    const childAddress = PrivateKey.random().toPublicKey().toBase58();
    const proposalHash = '43';
    await seedParentWithCreateChildProposal(parentAddress, proposalHash, childAddress);
    await setCursor(100);

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async (addr: string) =>
        addr === parentAddress ? [makeExecutionEvent(proposalHash, 20)] : [],
    }));

    const indexer = new MinaGuardIndexer(fullConfig);
    const parent = await prisma.contract.findUniqueOrThrow({ where: { address: parentAddress } });
    await indexer.backfillContract(parent.id, parentAddress);

    const child = await prisma.contract.findUnique({ where: { address: childAddress } });
    expect(child).toBeNull();
  });

  test('idempotent: running twice does not create a duplicate child', async () => {
    const parentAddress = PrivateKey.random().toPublicKey().toBase58();
    const childAddress = PrivateKey.random().toPublicKey().toBase58();
    const proposalHash = '44';
    await seedParentWithCreateChildProposal(parentAddress, proposalHash, childAddress);
    await setCursor(100);

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async (addr: string) =>
        addr === parentAddress ? [makeExecutionEvent(proposalHash, 20)] : [],
    }));

    const indexer = new MinaGuardIndexer(liteConfig);
    const parent = await prisma.contract.findUniqueOrThrow({ where: { address: parentAddress } });
    await indexer.backfillContract(parent.id, parentAddress);
    // Second pass: eventRaw fingerprint dedup prevents re-applying the
    // execution event, but maybeAutoSubscribeChild's own existing-check is
    // what prevents a duplicate child row here — both should hold.
    await indexer.backfillContract(parent.id, parentAddress);

    const childCount = await prisma.contract.count({ where: { address: childAddress } });
    expect(childCount).toBe(1);
  });
});

function makeExecutionEvent(proposalHash: string, blockHeight: number) {
  return {
    type: 'execution',
    event: { proposalHash },
    blockHeight,
    blockHash: `h${blockHeight}`,
    parentHash: `h${blockHeight - 1}`,
    txHash: `tx-${proposalHash}`,
  };
}

describe('tick: rescanUnreadyContracts', () => {
  async function runSingleTick(config: BackendConfig): Promise<MinaGuardIndexer> {
    const indexer = new MinaGuardIndexer(config);
    await indexer.start();
    indexer.stop();
    return indexer;
  }

  test('unready contract with no archive events stays unready', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({
      data: { address, ready: false, discoveredAtBlock: 50 },
    });
    await setCursor(100);

    let callCount = 0;
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchLatestBlockHeight: async () => 100,
      fetchBestChainHeaders: async () => [],
      fetchDecodedContractEvents: async () => {
        callCount += 1;
        return [];
      },
    }));

    await runSingleTick(liteConfig);

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.ready).toBe(false);
    // The rescan should have queried events for the unready contract at
    // least once during the tick.
    expect(callCount).toBeGreaterThan(0);
  });

  test('unready contract flips to ready on tick once events are present', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const contract = await prisma.contract.create({
      data: { address, ready: false, discoveredAtBlock: 50 },
    });
    await setCursor(100);

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchLatestBlockHeight: async () => 100,
      fetchBestChainHeaders: async () => [],
      // Return a MinaGuard execution event for the unready contract's
      // address — any event is proof the contract was initialized.
      fetchDecodedContractEvents: async (_addr: string, from: number) => {
        if (from <= 60) return [makeExecutionEvent('rescan-hash', 60)];
        return [];
      },
    }));

    await runSingleTick(liteConfig);

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.ready).toBe(true);
  });

  test('uses discoveredAtBlock as the lower bound of the rescan range', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    await prisma.contract.create({
      data: { address, ready: false, discoveredAtBlock: 77 },
    });
    await setCursor(100);

    const rescanRanges: Array<{ from: number; to: number }> = [];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchLatestBlockHeight: async () => 100,
      fetchBestChainHeaders: async () => [],
      fetchDecodedContractEvents: async (_addr: string, from: number, to: number) => {
        rescanRanges.push({ from, to });
        return [];
      },
    }));

    await runSingleTick(liteConfig);

    // The rescan-path call is the one with from === discoveredAtBlock.
    const rescan = rescanRanges.find((r) => r.from === 77);
    expect(rescan).toBeDefined();
    expect(rescan?.to).toBe(100);
  });

  test('skips contracts whose discoveredAtBlock is above latestHeight', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    await prisma.contract.create({
      data: { address, ready: false, discoveredAtBlock: 9999 },
    });
    await setCursor(100);

    const calls: string[] = [];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchLatestBlockHeight: async () => 100,
      fetchBestChainHeaders: async () => [],
      fetchDecodedContractEvents: async (addr: string) => {
        calls.push(addr);
        return [];
      },
    }));

    await runSingleTick(liteConfig);

    // The unready contract should not have been queried: its lower bound
    // sits above the chain tip, so there's nothing to rescan yet.
    expect(calls).not.toContain(address);
  });
});
