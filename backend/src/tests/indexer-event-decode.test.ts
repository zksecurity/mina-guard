/**
 * Per-event-type decode tests: synthetic ChainEvents are ingested through the
 * indexer's real sync path (syncSingleContract with fetchDecodedContractEvents
 * mocked) and asserted against the resulting DB rows. Replaces the indexer-side
 * verification of the chain-e2e steps cut to the UI suite: threshold change,
 * owner add/remove, delegate set/unset, child multi-sig toggle (which doubles
 * as the destroy state-flip), and transfer proposals with memo + receivers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import { MinaGuardIndexer } from '../indexer.js';
import { stubMinaClient } from './stub-mina-client.js';
import type { ChainEvent } from '../mina-client.js';

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

/** Seeds a contract row and ingests the given events through the real sync path. */
async function ingest(
  events: ChainEvent[],
  opts: { address?: string; toHeight?: number } = {}
): Promise<{ contractId: number; address: string }> {
  const address = opts.address ?? PrivateKey.random().toPublicKey().toBase58();
  const toHeight = opts.toHeight ?? 20;
  const contract = await prisma.contract.create({
    data: { address, discoveredAtBlock: 1 },
  });
  stubMinaClient(() => ({
    fetchDecodedContractEvents: async () => events,
  }));
  const indexer = new MinaGuardIndexer(stubConfig);
  await indexer.syncSingleContract(contract.id, address, 0, toHeight);
  return { contractId: contract.id, address };
}

/** Latest ContractConfig snapshot, as the route layer would read it. */
async function latestConfig(contractId: number) {
  return prisma.contractConfig.findFirstOrThrow({
    where: { contractId },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }, { id: 'desc' }],
  });
}

const HASHES = (h: number) => ({ blockHash: `hash-${h}`, parentHash: `hash-${h - 1}` });

/** setup + one owner at block 2 — the baseline every scenario builds on. */
function setupEvents(owner: string, extra: Partial<Record<string, string>> = {}): ChainEvent[] {
  return [
    {
      type: 'setup', blockHeight: 2, txHash: 'tx-setup', ...HASHES(2),
      event: {
        parent: null, threshold: '1', numOwners: '1',
        networkId: 'net', ownersCommitment: 'commit', ...extra,
      },
    },
    {
      type: 'setupOwner', blockHeight: 2, txHash: 'tx-setup', ...HASHES(2),
      event: { owner, index: '0' },
    },
  ];
}

describe('config-mutating event decoding', () => {
  const owner = PrivateKey.random().toPublicKey().toBase58();

  test('thresholdChange updates threshold and configNonce in the latest snapshot', async () => {
    const { contractId } = await ingest([
      ...setupEvents(owner),
      {
        type: 'thresholdChange', blockHeight: 5, txHash: 'tx-thr', ...HASHES(5),
        event: { newThreshold: '2', configNonce: '1' },
      },
    ]);

    const config = await latestConfig(contractId);
    expect(config.threshold).toBe(2);
    expect(config.configNonce).toBe(1);
    // Untouched fields carry forward from the setup snapshot
    expect(config.numOwners).toBe(1);
  });

  test('ownerChange add then remove tracks memberships, numOwners and ownersCommitment', async () => {
    const owner2 = PrivateKey.random().toPublicKey().toBase58();
    const { contractId } = await ingest([
      ...setupEvents(owner),
      {
        type: 'ownerChange', blockHeight: 5, txHash: 'tx-add', ...HASHES(5),
        event: {
          owner: owner2, added: '1', newNumOwners: '2',
          newOwnersCommitment: 'commit-add', configNonce: '1',
        },
      },
      {
        type: 'ownerChange', blockHeight: 8, txHash: 'tx-rm', ...HASHES(8),
        event: {
          owner: owner2, added: '0', newNumOwners: '1',
          newOwnersCommitment: 'commit-rm', configNonce: '2',
        },
      },
    ]);

    const memberships = await prisma.ownerMembership.findMany({
      where: { contractId, address: owner2 },
      orderBy: { validFromBlock: 'asc' },
    });
    expect(memberships.map((m) => m.action)).toEqual(['added', 'removed']);

    const config = await latestConfig(contractId);
    expect(config.numOwners).toBe(1);
    expect(config.configNonce).toBe(2);
    // Must track the event, not carry setup's 'commit' forward.
    expect(config.ownersCommitment).toBe('commit-rm');
  });

  test('ownerChange without a commitment carries the previous one forward', async () => {
    const owner2 = PrivateKey.random().toPublicKey().toBase58();
    const { contractId } = await ingest([
      ...setupEvents(owner),
      {
        type: 'ownerChange', blockHeight: 5, txHash: 'tx-add', ...HASHES(5),
        event: { owner: owner2, added: '1', newNumOwners: '2', configNonce: '1' },
      },
    ]);

    const config = await latestConfig(contractId);
    expect(config.numOwners).toBe(2);
    expect(config.ownersCommitment).toBe('commit');
  });

  test('delegate event sets the delegate; self-delegation records the undelegate state', async () => {
    const delegate = PrivateKey.random().toPublicKey().toBase58();
    const { contractId, address } = await ingest([
      ...setupEvents(owner),
      {
        type: 'delegate', blockHeight: 5, txHash: 'tx-del', ...HASHES(5),
        event: { delegate },
      },
    ]);
    expect((await latestConfig(contractId)).delegate).toBe(delegate);

    // Undelegate = the contract delegating to itself (chain-e2e former steps 21-22)
    stubMinaClient(() => ({
      fetchDecodedContractEvents: async (): Promise<ChainEvent[]> => [
        {
          type: 'delegate', blockHeight: 9, txHash: 'tx-undel', ...HASHES(9),
          event: { delegate: address },
        },
      ],
    }));
    const indexer = new MinaGuardIndexer(stubConfig);
    await indexer.syncSingleContract(contractId, address, 9, 12);
    expect((await latestConfig(contractId)).delegate).toBe(address);
  });

  test('enableChildMultiSig toggles the flag (and is the destroy state-flip)', async () => {
    const { contractId } = await ingest([
      ...setupEvents(owner),
      {
        type: 'enableChildMultiSig', blockHeight: 5, txHash: 'tx-dis', ...HASHES(5),
        event: { enabled: '0' },
      },
    ]);
    expect((await latestConfig(contractId)).childMultiSigEnabled).toBe(false);
  });
});

describe('proposal event decoding', () => {
  const owner = PrivateKey.random().toPublicKey().toBase58();

  test('transfer proposal with memo hash, tx memo, and receivers', async () => {
    const recipient = PrivateKey.random().toPublicKey().toBase58();
    const recipient2 = PrivateKey.random().toPublicKey().toBase58();
    const address = PrivateKey.random().toPublicKey().toBase58();
    const { contractId } = await ingest([
      ...setupEvents(owner),
      {
        type: 'proposal', blockHeight: 6, txHash: 'tx-prop', ...HASHES(6),
        txMemo: 'raw-memo',
        event: {
          proposalHash: 'PROP', proposer: owner, tokenId: '1', txType: '0',
          data: 'd', uid: 'u1', nonce: '1', configNonce: '0', expirySlot: '0',
          memoHash: '777', networkId: 'net', guardAddress: address,
          destination: '0', childAccount: null,
        },
      },
      {
        type: 'receiver', blockHeight: 6, txHash: 'tx-prop', ...HASHES(6),
        event: { proposalHash: 'PROP', receiver: recipient, amount: '1000000000' },
      },
      {
        type: 'receiver', blockHeight: 6, txHash: 'tx-prop', ...HASHES(6),
        event: { proposalHash: 'PROP', receiver: recipient2, amount: '500000000' },
      },
    ] as ChainEvent[], { address });

    const proposal = await prisma.proposal.findUniqueOrThrow({
      where: { contractId_proposalHash: { contractId, proposalHash: 'PROP' } },
      include: { receivers: { orderBy: { idx: 'asc' } } },
    });
    expect(proposal.txType).toBe('0');
    expect(proposal.nonce).toBe('1');
    expect(proposal.memoHash).toBe('777');
    expect(proposal.memo).not.toBeNull(); // decoded from txMemo
    // Same-block ordering is an archive concern; assert the pairs, not idx order.
    expect(
      proposal.receivers.map((r) => [r.address, r.amount]).sort()
    ).toEqual(
      [
        [recipient, '1000000000'],
        [recipient2, '500000000'],
      ].sort()
    );
  });
});
