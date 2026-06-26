import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import { MinaGuardIndexer } from '../indexer.js';
import * as minaClient from '../mina-client.js';

const VK_HASH = '22592591136635241954458728867125272730912271761728581931779127524287952990537';

const archiveConfig = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
  archiveEndpoint: 'http://stub',
  archiveFallbackEndpoint: null,
  indexPollIntervalMs: 1000,
  indexStartHeight: 0,
  minaguardVkHash: VK_HASH,
  lightnetAccountManager: null,
  indexerMode: 'full' as const,
  discoveryBackend: 'archive' as const,
  archiveDb: {
    host: 'stub-host',
    port: 5432,
    user: 'stub-user',
    password: 'stub-pass',
    database: 'stub-db',
  },
} as unknown as BackendConfig;

async function setIndexedHeight(height: number) {
  await prisma.indexerCursor.upsert({
    where: { key: 'indexed_height' },
    create: { key: 'indexed_height', value: String(height) },
    update: { value: String(height) },
  });
}

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

describe('archive discovery: happy path', () => {
  test('discovers contracts returned by archive query, stores deploy block as discoveredAtBlock, and advances cursor', async () => {
    const candidates = [
      { address: PrivateKey.random().toPublicKey().toBase58(), deployBlock: 100 },
      { address: PrivateKey.random().toPublicKey().toBase58(), deployBlock: 250 },
      { address: PrivateKey.random().toPublicKey().toBase58(), deployBlock: 700 },
    ];

    let archiveQueryCalledWith: { from: number; to: number } | null = null;
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchGenesisConstants: async () => ({ genesisTimestampMs: 0, slotDurationMs: 90000 }),
      fetchLatestBlockHeightFromArchive: async () => 1000,
      fetchBestChainHeaders: async () => [],
      discoverCandidateAddressesFromArchive: async (
        _pool: unknown,
        _vkHash: string,
        from: number,
        to: number,
      ) => {
        archiveQueryCalledWith = { from, to };
        return candidates;
      },
      // All 3 candidates verify with the matching MinaGuard VK on-chain.
      fetchVerificationKeyHash: async () => VK_HASH,
      // Backfill is a no-op (no events emitted yet).
      fetchDecodedContractEvents: async () => [],
    }));

    const indexer = new MinaGuardIndexer(archiveConfig);
    await indexer.start();
    indexer.stop();

    // Archive scan covers [indexStartHeight, latestHeight] on cold start.
    expect(archiveQueryCalledWith).toEqual({ from: 0, to: 1000 });

    const contracts = await prisma.contract.findMany({ orderBy: { address: 'asc' } });
    expect(contracts.map((c) => c.address).sort()).toEqual(candidates.map((c) => c.address).sort());

    // Critical: discoveredAtBlock must be the actual deploy block, not the
    // tick's chain tip. This is what makes rescanUnreadyContracts's
    // [discoveredAtBlock, latestHeight] window cover the deploy events
    // (without it, archive-discovered contracts would have a permanent
    // blind spot below the tick's chain tip).
    const byAddr = new Map(contracts.map((c) => [c.address, c.discoveredAtBlock]));
    for (const { address, deployBlock } of candidates) {
      expect(byAddr.get(address)).toBe(deployBlock);
    }

    const cursor = await prisma.indexerCursor.findUnique({
      where: { key: 'archive_discovered_height' },
    });
    expect(cursor?.value).toBe('1000');
  });

  test('skips candidates whose on-chain VK no longer matches (e.g. VK got upgraded after deploy)', async () => {
    const matching = PrivateKey.random().toPublicKey().toBase58();
    const mismatched = PrivateKey.random().toPublicKey().toBase58();

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchGenesisConstants: async () => ({ genesisTimestampMs: 0, slotDurationMs: 90000 }),
      fetchLatestBlockHeightFromArchive: async () => 500,
      fetchBestChainHeaders: async () => [],
      discoverCandidateAddressesFromArchive: async () => [
        { address: matching, deployBlock: 200 },
        { address: mismatched, deployBlock: 300 },
      ],
      fetchVerificationKeyHash: async (addr: string) =>
        addr === matching ? VK_HASH : 'different-vk-hash',
      fetchDecodedContractEvents: async () => [],
    }));

    const indexer = new MinaGuardIndexer(archiveConfig);
    await indexer.start();
    indexer.stop();

    const contracts = await prisma.contract.findMany();
    expect(contracts.map((c) => c.address)).toEqual([matching]);
  });
});

describe('archive discovery: per-iteration failure isolation', () => {
  test('a thrown error processing one candidate does not abort processing of the rest', async () => {
    // Regression test for the "swallow whole batch on first failure" bug.
    // Without per-iteration try/catch in processCandidateAddresses, an error
    // on candidate B aborts the for-loop and candidates C+D never get processed
    // — they're then lost forever because the archive_discovered_height cursor
    // still advances in the finally block.
    const ok1 = PrivateKey.random().toPublicKey().toBase58();
    const bad = PrivateKey.random().toPublicKey().toBase58();
    const ok2 = PrivateKey.random().toPublicKey().toBase58();

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchGenesisConstants: async () => ({ genesisTimestampMs: 0, slotDurationMs: 90000 }),
      fetchLatestBlockHeightFromArchive: async () => 1000,
      fetchBestChainHeaders: async () => [],
      discoverCandidateAddressesFromArchive: async () => [
        { address: ok1, deployBlock: 100 },
        { address: bad, deployBlock: 200 },
        { address: ok2, deployBlock: 300 },
      ],
      fetchVerificationKeyHash: async (addr: string) => {
        if (addr === bad) throw new Error('simulated daemon hiccup on VK fetch');
        return VK_HASH;
      },
      fetchDecodedContractEvents: async () => [],
    }));

    const indexer = new MinaGuardIndexer(archiveConfig);
    await indexer.start();
    indexer.stop();

    const contracts = await prisma.contract.findMany();
    const addrs = contracts.map((c) => c.address).sort();
    // ok2 MUST be in the DB despite `bad` throwing earlier in the loop.
    expect(addrs).toEqual([ok1, ok2].sort());

    // Cursor must NOT advance when any candidate fails — so the next tick
    // re-scans the same range and gets another shot at `bad`. Without this
    // gate, `bad` would be silently dropped forever once the cursor moved
    // past its deploy block.
    const cursor = await prisma.indexerCursor.findUnique({
      where: { key: 'archive_discovered_height' },
    });
    expect(cursor).toBeNull();
  });

  test('backfill failure on one candidate does not abort processing of the rest, and cursor stays held', async () => {
    // Another shape of the same bug: backfillContract throws (not VK fetch).
    // Same expectation — other candidates still get processed, AND the cursor
    // does not advance so the next tick re-scans the same range and can retry
    // backfill for `bad`. Pre-seed indexedHeight so backfillContract actually
    // runs (it short-circuits when indexedHeight <= backfillFrom).
    await setIndexedHeight(999);

    const ok = PrivateKey.random().toPublicKey().toBase58();
    const bad = PrivateKey.random().toPublicKey().toBase58();

    let backfillCallCountForBad = 0;
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchGenesisConstants: async () => ({ genesisTimestampMs: 0, slotDurationMs: 90000 }),
      fetchLatestBlockHeightFromArchive: async () => 1000,
      fetchBestChainHeaders: async () => [],
      discoverCandidateAddressesFromArchive: async () => [
        { address: bad, deployBlock: 100 },
        { address: ok, deployBlock: 200 },
      ],
      fetchVerificationKeyHash: async () => VK_HASH,
      fetchDecodedContractEvents: async (addr: string) => {
        if (addr === bad) {
          backfillCallCountForBad += 1;
          throw new Error('simulated archive-node-api outage');
        }
        return [];
      },
    }));

    const indexer = new MinaGuardIndexer(archiveConfig);
    await indexer.start();
    indexer.stop();

    expect(backfillCallCountForBad).toBeGreaterThan(0);

    // `ok` was inserted despite `bad` blowing up first.
    const contracts = await prisma.contract.findMany();
    expect(contracts.map((c) => c.address)).toContain(ok);

    // Cursor held — next tick will re-scan and retry backfill for `bad`.
    // (`bad`'s contract row was already created before backfill threw, so
    // rescanUnreadyContracts will also retry it on subsequent ticks.)
    const cursor = await prisma.indexerCursor.findUnique({
      where: { key: 'archive_discovered_height' },
    });
    expect(cursor).toBeNull();
  });
});

describe('archive discovery: backfill range', () => {
  test('backfill for a newly-discovered contract starts from indexStartHeight, not indexedHeight - 300', async () => {
    // Regression test for the "historical event gap" bug: under full mode +
    // daemon discovery, backfill spans the last 300 blocks (safe because
    // daemon-discovery can't surface anything older). Archive-discovery can
    // surface a deploy from 50k blocks ago — but with the old 300-block guard,
    // every event between the deploy and (indexedHeight - 300) would be lost.
    // This test pins the fix: archive backend uses indexStartHeight (the same
    // lite-mode/manual-subscribe-with-fromBlock=0 path) regardless of how
    // far ahead the indexer's cursor has advanced.
    // Simulate: indexer has been running, cursor at 49999, archive scan now
    // surfaces a contract whose deploy block is somewhere in [0, 49999].
    // Without the seed, backfillContract short-circuits (indexedHeight=0,
    // backfillFrom=0, nothing to fetch).
    await setIndexedHeight(49_999);

    const addr = PrivateKey.random().toPublicKey().toBase58();

    const backfillCalls: Array<{ from: number; to: number }> = [];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchGenesisConstants: async () => ({ genesisTimestampMs: 0, slotDurationMs: 90000 }),
      fetchLatestBlockHeightFromArchive: async () => 50_000,
      fetchBestChainHeaders: async () => [],
      discoverCandidateAddressesFromArchive: async () => [{ address: addr, deployBlock: 12_345 }],
      fetchVerificationKeyHash: async () => VK_HASH,
      fetchDecodedContractEvents: async (_addr: string, from: number, to: number) => {
        backfillCalls.push({ from, to });
        return [];
      },
    }));

    const indexer = new MinaGuardIndexer(archiveConfig);
    await indexer.start();
    indexer.stop();

    // First call to fetchDecodedContractEvents is the backfill triggered by
    // discovery. Lower bound must be indexStartHeight (0 in this config),
    // NOT indexedHeight - 300 = 49699 (the old daemon-discovery guard).
    expect(backfillCalls.length).toBeGreaterThan(0);
    expect(backfillCalls[0].from).toBe(0);
    expect(backfillCalls[0].to).toBe(49_999);
  });
});

describe('archive discovery: cursor progression', () => {
  test('uses indexStartHeight on cold start; uses prior cursor minus margin on subsequent runs', async () => {
    // First tick: no cursor exists; archive query should be called with from=indexStartHeight=0.
    // After the tick, archive_discovered_height = latestHeight.
    // Second tick at a higher latestHeight: from = max(indexStartHeight, prevCursor - DISCOVERY_MARGIN).
    const calls: Array<{ from: number; to: number }> = [];

    let latestHeight = 1000;
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchGenesisConstants: async () => ({ genesisTimestampMs: 0, slotDurationMs: 90000 }),
      fetchLatestBlockHeightFromArchive: async () => latestHeight,
      fetchBestChainHeaders: async () => [],
      discoverCandidateAddressesFromArchive: async (
        _pool: unknown,
        _vkHash: string,
        from: number,
        to: number,
      ) => {
        calls.push({ from, to });
        return [];
      },
      fetchVerificationKeyHash: async () => VK_HASH,
      fetchDecodedContractEvents: async () => [],
    }));

    const indexer = new MinaGuardIndexer(archiveConfig);
    await indexer.start();
    indexer.stop();
    expect(calls[0]).toEqual({ from: 0, to: 1000 });

    // Bump chain tip and re-run.
    latestHeight = 1500;
    const indexer2 = new MinaGuardIndexer(archiveConfig);
    await indexer2.start();
    indexer2.stop();
    // DISCOVERY_MARGIN is 5 in the source.
    expect(calls[1]).toEqual({ from: 1000 - 5, to: 1500 });
  });
});
