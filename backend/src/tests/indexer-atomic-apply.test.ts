/**
 * An event's EventRaw marker and its derived state changes commit together or
 * not at all. Written without provider-specific SQL so the same file runs
 * against both Postgres (hosted) and SQLite (desktop).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/index.js';
import { MinaGuardIndexer, isTransientDbError } from '../indexer.js';
import type { ChainEvent } from '../mina-client.js';
import { stubMinaClient } from './stub-mina-client.js';

const stubConfig = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
  archiveEndpoint: 'http://stub',
  archiveFallbackEndpoint: null,
  indexPollIntervalMs: 1000,
  indexStartHeight: 0,
  minaguardVkHash: '0',
  lightnetAccountManager: null,
  indexerMode: 'full' as const,
  discoveryBackend: 'daemon' as const,
} as unknown as BackendConfig;

async function clearAll() {
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.blockHeader.deleteMany();
  await prisma.contract.deleteMany();
}

beforeEach(clearAll);
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

const HASHES = (h: number) => ({ blockHash: `hash-${h}`, parentHash: `hash-${h - 1}` });

const setupEvent: ChainEvent = {
  type: 'setup', blockHeight: 5, txHash: 'tx-setup', txMemo: null, ...HASHES(5),
  event: { parent: null, threshold: '1', numOwners: '1', networkId: 'net', ownersCommitment: 'commit' },
};
const thresholdEvent: ChainEvent = {
  type: 'thresholdChange', blockHeight: 6, txHash: 'tx-thr', txMemo: null, ...HASHES(6),
  event: { newThreshold: '2', configNonce: '1' },
};

async function seedContract(events: ChainEvent[]) {
  const address = PrivateKey.random().toPublicKey().toBase58();
  const contract = await prisma.contract.create({
    data: { address, discoveredAtBlock: 1, permissionsVerified: true },
  });
  stubMinaClient(() => ({
    fetchDecodedContractEvents: async () => events,
    fetchOnChainState: async () => null,
  }));
  return { contractId: contract.id, address };
}

type SnapshotWriter = (...args: unknown[]) => Promise<void>;

/**
 * Makes config snapshot writes for events at `blockHeight` succeed, then throw
 * `error` (up to `times` times), so the failure lands after a derived write.
 */
function failSnapshotWritesAt(
  indexer: MinaGuardIndexer,
  blockHeight: number,
  error: () => unknown,
  times = Infinity,
) {
  const target = indexer as unknown as { appendContractConfigSnapshot: SnapshotWriter };
  const real = target.appendContractConfigSnapshot.bind(indexer);
  let remaining = times;
  target.appendContractConfigSnapshot = async (...args) => {
    await real(...args);
    if (args[2] === blockHeight && remaining > 0) {
      remaining--;
      throw error();
    }
  };
}

const transient = () =>
  new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
    code: 'P1017',
    clientVersion: 'test',
  });

describe('atomic event application', () => {
  test('a transient failure after a derived write leaves nothing behind, and the next sync applies the event', async () => {
    const { contractId, address } = await seedContract([setupEvent]);
    const indexer = new MinaGuardIndexer(stubConfig);
    failSnapshotWritesAt(indexer, 5, transient, 1);

    await expect(indexer.syncSingleContract(contractId, address, 0, 20)).rejects.toThrow('closed the connection');
    expect(await prisma.eventRaw.count()).toBe(0);
    expect(await prisma.contractConfig.count()).toBe(0);
    expect(await prisma.blockHeader.count()).toBe(0);

    await indexer.syncSingleContract(contractId, address, 0, 20);
    const raw = await prisma.eventRaw.findMany();
    expect(raw).toHaveLength(1);
    expect(raw[0].applyError).toBeNull();
    expect(await prisma.contractConfig.count()).toBe(1);
  });

  test('a deterministic failure records the event with applyError and no state changes, and later events still apply', async () => {
    const { contractId, address } = await seedContract([setupEvent, thresholdEvent]);
    const indexer = new MinaGuardIndexer(stubConfig);
    failSnapshotWritesAt(indexer, 5, () => new TypeError('bad event data'));

    await indexer.syncSingleContract(contractId, address, 0, 20);

    const raw = await prisma.eventRaw.findMany({ orderBy: { blockHeight: 'asc' } });
    expect(raw.map((r) => r.eventType)).toEqual(['setup', 'thresholdChange']);
    expect(raw[0].applyError).toContain('bad event data');
    expect(raw[1].applyError).toBeNull();
    // Only the thresholdChange snapshot exists: the setup snapshot was rolled back.
    const configs = await prisma.contractConfig.findMany();
    expect(configs).toHaveLength(1);
    expect(configs[0].threshold).toBe(2);
    expect(configs[0].validFromBlock).toBe(6);

    // A quarantined event is not retried.
    await indexer.syncSingleContract(contractId, address, 0, 20);
    expect(await prisma.eventRaw.count()).toBe(2);
    expect(await prisma.contractConfig.count()).toBe(1);
  });

  test('a non-transient error that does not repeat is retried and applies', async () => {
    const { contractId, address } = await seedContract([setupEvent]);
    const indexer = new MinaGuardIndexer(stubConfig);
    failSnapshotWritesAt(indexer, 5, () => new TypeError('one-off'), 1);

    await indexer.syncSingleContract(contractId, address, 0, 20);

    const raw = await prisma.eventRaw.findMany();
    expect(raw).toHaveLength(1);
    expect(raw[0].applyError).toBeNull();
    expect(await prisma.contractConfig.count()).toBe(1);
  });

  test('an API write while an event transaction is open waits for it instead of failing', async () => {
    // SQLite allows one writer, so the API write must queue behind the open
    // event transaction; Postgres runs it concurrently. Either way it succeeds.
    const { contractId, address } = await seedContract([setupEvent]);
    const other = await prisma.contract.create({
      data: { address: PrivateKey.random().toPublicKey().toBase58(), permissionsVerified: true },
    });
    const indexer = new MinaGuardIndexer(stubConfig);
    const target = indexer as unknown as { appendContractConfigSnapshot: SnapshotWriter };
    const real = target.appendContractConfigSnapshot.bind(indexer);
    let entered!: () => void;
    const insideTransaction = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    target.appendContractConfigSnapshot = async (...args) => {
      await real(...args);
      entered();
      await gate;
    };

    const sync = indexer.syncSingleContract(contractId, address, 0, 20);
    await insideTransaction;
    // Promise.resolve starts the lazy PrismaPromise now, while the transaction is open.
    const apiWrite = Promise.resolve(prisma.contract.update({ where: { id: other.id }, data: { ready: true } }));
    setTimeout(release, 300);

    await expect(apiWrite).resolves.toMatchObject({ ready: true });
    await sync;
    expect(await prisma.contractConfig.count()).toBe(1);
  });

  test('concurrent syncs of two vaults with events at the same height both apply', async () => {
    // Both write BlockHeader(5); Prisma's upsert is read-then-insert, so the
    // later writer can fail on the row the earlier one just committed.
    const vaults = await Promise.all([0, 1].map(async () => {
      const address = PrivateKey.random().toPublicKey().toBase58();
      const contract = await prisma.contract.create({
        data: { address, discoveredAtBlock: 1, permissionsVerified: true },
      });
      return { contractId: contract.id, address };
    }));
    stubMinaClient(() => ({
      fetchDecodedContractEvents: async (address: string) =>
        [{ ...setupEvent, txHash: `tx-setup-${address}` }],
      fetchOnChainState: async () => null,
    }));

    await Promise.all(vaults.map(({ contractId, address }) =>
      new MinaGuardIndexer(stubConfig).syncSingleContract(contractId, address, 0, 20)));

    const raw = await prisma.eventRaw.findMany();
    expect(raw).toHaveLength(2);
    expect(raw.map((r) => r.applyError)).toEqual([null, null]);
    expect(await prisma.contractConfig.count()).toBe(2);
    expect(await prisma.blockHeader.count()).toBe(1);
  });

  test('overlapping syncs of the same events apply each event exactly once', async () => {
    const { contractId, address } = await seedContract([setupEvent, thresholdEvent]);
    const a = new MinaGuardIndexer(stubConfig);
    const b = new MinaGuardIndexer(stubConfig);

    await Promise.all([
      a.syncSingleContract(contractId, address, 0, 20),
      b.syncSingleContract(contractId, address, 0, 20),
    ]);

    const raw = await prisma.eventRaw.findMany();
    expect(raw).toHaveLength(2);
    expect(raw.every((r) => r.applyError === null)).toBe(true);
    expect(await prisma.contractConfig.count()).toBe(2);
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.ready).toBe(true);
  });
});

describe('isTransientDbError', () => {
  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

  test('retries connection, timeout, pool, aborted-transaction and write-conflict failures', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']) {
      expect(isTransientDbError(known(code))).toBe(true);
    }
    expect(isTransientDbError(new Prisma.PrismaClientInitializationError('x', 'test'))).toBe(true);
  });

  test('treats constraint, validation and code errors as deterministic', () => {
    for (const code of ['P2002', 'P2003', 'P2025', 'P2000']) {
      expect(isTransientDbError(known(code))).toBe(false);
    }
    expect(isTransientDbError(new Prisma.PrismaClientValidationError('x', { clientVersion: 'test' }))).toBe(false);
    expect(isTransientDbError(new TypeError('x'))).toBe(false);
  });
});
