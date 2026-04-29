import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import { prisma } from '../db.js';
import { MinaGuardIndexer, detectAndRollbackReorg, rollbackAboveFork } from '../indexer.js';
import * as minaClient from '../mina-client.js';
import type { ChainEvent } from '../mina-client.js';
import type { BackendConfig } from '../config.js';

const stubConfig = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
  archiveEndpoint: 'http://stub',
  archiveFallbackEndpoint: null,
  indexPollIntervalMs: 1000,
  indexStartHeight: 0,
  minaguardVkHash: null,
  lightnetAccountManager: null,
} as unknown as BackendConfig;

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

async function seedHeaders(chain: Array<{ height: number; blockHash: string; parentHash: string }>) {
  for (const h of chain) {
    await prisma.blockHeader.create({ data: h });
  }
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

describe('rollbackAboveFork', () => {
  test('deletes rows strictly above fork across every per-block table', async () => {
    const contract = await prisma.contract.create({
      data: { address: PrivateKey.random().toPublicKey().toBase58(), discoveredAtBlock: 5 },
    });
    // Contract discovered above fork should be deleted; keep a reference by
    // address rather than an unused variable so the deletion is self-evident.
    const orphanAddress = PrivateKey.random().toPublicKey().toBase58();
    await prisma.contract.create({
      data: { address: orphanAddress, discoveredAtBlock: 20 },
    });

    // Seed one row per height-keyed table below and above the fork.
    await prisma.blockHeader.createMany({
      data: [
        { height: 5, blockHash: 'h5', parentHash: 'h4' },
        { height: 10, blockHash: 'h10', parentHash: 'h9' },
        { height: 15, blockHash: 'h15', parentHash: 'h14' },
      ],
    });
    await prisma.eventRaw.createMany({
      data: [
        { contractId: contract.id, blockHeight: 5, eventType: 'setup', payload: '{}', fingerprint: 'rollback-ev-5' },
        { contractId: contract.id, blockHeight: 15, eventType: 'proposal', payload: '{}', fingerprint: 'rollback-ev-15' },
      ],
    });
    await prisma.contractConfig.createMany({
      data: [
        { contractId: contract.id, validFromBlock: 5, threshold: 2 },
        { contractId: contract.id, validFromBlock: 15, threshold: 3 },
      ],
    });
    await prisma.ownerMembership.createMany({
      data: [
        { contractId: contract.id, address: 'addr1', action: 'added', validFromBlock: 5 },
        { contractId: contract.id, address: 'addr1', action: 'removed', validFromBlock: 15 },
      ],
    });
    await prisma.proposal.createMany({
      data: [
        { contractId: contract.id, proposalHash: 'below', createdAtBlock: 5 },
        { contractId: contract.id, proposalHash: 'above', createdAtBlock: 15 },
      ],
    });
    const belowProposal = await prisma.proposal.findUniqueOrThrow({
      where: { contractId_proposalHash: { contractId: contract.id, proposalHash: 'below' } },
    });
    await prisma.proposalExecution.create({
      data: { proposalId: belowProposal.id, blockHeight: 15 },
    });
    await prisma.approval.createMany({
      data: [
        { proposalId: belowProposal.id, approver: 'a1', blockHeight: 6 },
        { proposalId: belowProposal.id, approver: 'a2', blockHeight: 15 },
      ],
    });
    await prisma.indexerCursor.create({ data: { key: 'indexed_height', value: '15' } });

    await rollbackAboveFork(10);

    expect(await prisma.blockHeader.findMany()).toHaveLength(2);
    expect(await prisma.eventRaw.findMany()).toHaveLength(1);
    expect(await prisma.contractConfig.findMany()).toHaveLength(1);
    expect(await prisma.ownerMembership.findMany()).toHaveLength(1);
    expect(await prisma.proposal.findMany()).toHaveLength(1);
    expect(await prisma.proposalExecution.findMany()).toHaveLength(0);
    expect(await prisma.approval.findMany()).toHaveLength(1);
    // orphanContract.discoveredAtBlock=20 > 10, so it goes. contract was discovered at 5, stays.
    expect((await prisma.contract.findMany()).map((c) => c.id)).toEqual([contract.id]);

    const cursor = await prisma.indexerCursor.findUnique({ where: { key: 'indexed_height' } });
    expect(cursor?.value).toBe('10');
  });

  test('is a no-op when nothing is above fork', async () => {
    const contract = await prisma.contract.create({
      data: { address: PrivateKey.random().toPublicKey().toBase58(), discoveredAtBlock: 5 },
    });
    await seedHeaders([
      { height: 5, blockHash: 'h5', parentHash: 'h4' },
      { height: 10, blockHash: 'h10', parentHash: 'h9' },
    ]);
    await prisma.eventRaw.create({
      data: { contractId: contract.id, blockHeight: 5, eventType: 'setup', payload: '{}', fingerprint: 'noop-ev-5' },
    });
    await prisma.contractConfig.create({
      data: { contractId: contract.id, validFromBlock: 5, threshold: 2 },
    });
    await prisma.ownerMembership.create({
      data: { contractId: contract.id, address: 'addr-noop', action: 'added', validFromBlock: 5 },
    });
    await prisma.proposal.create({
      data: { contractId: contract.id, proposalHash: 'p-noop', createdAtBlock: 5 },
    });
    await prisma.indexerCursor.create({ data: { key: 'indexed_height', value: '10' } });

    await rollbackAboveFork(20);

    // All rows below fork must survive untouched.
    expect(await prisma.blockHeader.count()).toBe(2);
    expect(await prisma.eventRaw.count()).toBe(1);
    expect(await prisma.contractConfig.count()).toBe(1);
    expect(await prisma.ownerMembership.count()).toBe(1);
    expect(await prisma.proposal.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
    // Cursor is rewound to the fork even on a no-op rollback. This is the
    // current rollback contract: caller passes a fork height, cursor reflects it.
    const cursor = await prisma.indexerCursor.findUnique({ where: { key: 'indexed_height' } });
    expect(cursor?.value).toBe('20');
  });
});

describe('detectAndRollbackReorg', () => {
  test('returns null when stored headers agree with chain', async () => {
    await seedHeaders([
      { height: 5, blockHash: 'h5', parentHash: 'h4' },
      { height: 6, blockHash: 'h6', parentHash: 'h5' },
    ]);

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => [
        { height: 5, blockHash: 'h5', parentHash: 'h4' },
        { height: 6, blockHash: 'h6', parentHash: 'h5' },
      ],
    }));

    const result = await detectAndRollbackReorg(stubConfig);
    expect(result).toBeNull();
  });

  test('returns null when no stored headers overlap the chain window', async () => {
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => [
        { height: 100, blockHash: 'h100', parentHash: 'h99' },
      ],
    }));

    const result = await detectAndRollbackReorg(stubConfig);
    expect(result).toBeNull();
  });

  test('detects single-block mismatch: fork is the last agreed height', async () => {
    await seedHeaders([
      { height: 5, blockHash: 'h5', parentHash: 'h4' },
      { height: 6, blockHash: 'h6', parentHash: 'h5' },
      { height: 7, blockHash: 'h7', parentHash: 'h6' },
      { height: 8, blockHash: 'h8-old', parentHash: 'h7' },
    ]);
    await prisma.eventRaw.create({
      data: { blockHeight: 8, eventType: 'x', payload: '{}', fingerprint: 'post-fork-event' },
    });
    await prisma.indexerCursor.create({ data: { key: 'indexed_height', value: '8' } });

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => [
        { height: 5, blockHash: 'h5', parentHash: 'h4' },
        { height: 6, blockHash: 'h6', parentHash: 'h5' },
        { height: 7, blockHash: 'h7', parentHash: 'h6' },
        { height: 8, blockHash: 'h8-NEW', parentHash: 'h7' },
      ],
    }));

    const fork = await detectAndRollbackReorg(stubConfig);
    expect(fork).toBe(7);

    const remaining = await prisma.blockHeader.findMany({ orderBy: { height: 'asc' } });
    expect(remaining.map((r) => r.height)).toEqual([5, 6, 7]);
    expect(await prisma.eventRaw.findMany()).toHaveLength(0);
    const cursor = await prisma.indexerCursor.findUnique({ where: { key: 'indexed_height' } });
    expect(cursor?.value).toBe('7');
  });

  test('detects multi-block reorg: fork is the deepest agreed height, not tip-1', async () => {
    // Stored: 5, 6 agree. 7, 8, 9 are all on the losing fork.
    // Correct fork = 6. A naive "first mismatch - 1" would incorrectly return 8
    // and leave the stale h7-old row in the DB.
    await seedHeaders([
      { height: 5, blockHash: 'h5', parentHash: 'h4' },
      { height: 6, blockHash: 'h6', parentHash: 'h5' },
      { height: 7, blockHash: 'h7-old', parentHash: 'h6' },
      { height: 8, blockHash: 'h8-old', parentHash: 'h7-old' },
      { height: 9, blockHash: 'h9-old', parentHash: 'h8-old' },
    ]);
    await prisma.eventRaw.createMany({
      data: [
        { blockHeight: 7, eventType: 'x', payload: '{}', fingerprint: 'ev-7' },
        { blockHeight: 8, eventType: 'x', payload: '{}', fingerprint: 'ev-8' },
        { blockHeight: 9, eventType: 'x', payload: '{}', fingerprint: 'ev-9' },
      ],
    });
    await prisma.indexerCursor.create({ data: { key: 'indexed_height', value: '9' } });

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => [
        { height: 5, blockHash: 'h5', parentHash: 'h4' },
        { height: 6, blockHash: 'h6', parentHash: 'h5' },
        { height: 7, blockHash: 'h7-NEW', parentHash: 'h6' },
        { height: 8, blockHash: 'h8-NEW', parentHash: 'h7-NEW' },
        { height: 9, blockHash: 'h9-NEW', parentHash: 'h8-NEW' },
      ],
    }));

    const fork = await detectAndRollbackReorg(stubConfig);
    expect(fork).toBe(6);

    const remaining = await prisma.blockHeader.findMany({ orderBy: { height: 'asc' } });
    expect(remaining.map((r) => r.height)).toEqual([5, 6]);
    expect(await prisma.eventRaw.findMany()).toHaveLength(0);
    const cursor = await prisma.indexerCursor.findUnique({ where: { key: 'indexed_height' } });
    expect(cursor?.value).toBe('6');
  });

  test('bails safely when entire detection window disagrees (reorg deeper than window)', async () => {
    await seedHeaders([
      { height: 5, blockHash: 'h5-old', parentHash: 'h4-old' },
      { height: 6, blockHash: 'h6-old', parentHash: 'h5-old' },
    ]);
    await prisma.indexerCursor.create({ data: { key: 'indexed_height', value: '6' } });

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => [
        { height: 5, blockHash: 'h5-NEW', parentHash: 'h4-NEW' },
        { height: 6, blockHash: 'h6-NEW', parentHash: 'h5-NEW' },
      ],
    }));

    const fork = await detectAndRollbackReorg(stubConfig);
    expect(fork).toBeNull();
    // Nothing rolled back — state is preserved, operator has to intervene.
    expect(await prisma.blockHeader.findMany()).toHaveLength(2);
    const cursor = await prisma.indexerCursor.findUnique({ where: { key: 'indexed_height' } });
    expect(cursor?.value).toBe('6');
  });

  test('returns null if daemon fetch throws', async () => {
    await seedHeaders([{ height: 10, blockHash: 'h10', parentHash: 'h9' }]);

    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => { throw new Error('boom'); },
    }));

    const result = await detectAndRollbackReorg(stubConfig);
    expect(result).toBeNull();
    expect(await prisma.blockHeader.findMany()).toHaveLength(1);
  });
});

describe('reconstruction after rollback', () => {
  test('ingests new canonical chain after reorg; final state matches new chain only', async () => {
    const address = PrivateKey.random().toPublicKey().toBase58();
    const ownerA = PrivateKey.random().toPublicKey().toBase58();
    const ownerB = PrivateKey.random().toPublicKey().toBase58();

    const contract = await prisma.contract.create({
      data: { address, discoveredAtBlock: 4 },
    });
    const indexer = new MinaGuardIndexer(stubConfig);

    // Old chain: hashes h5..h9. Events: setup + two setupOwner at 5,
    // proposal 'OLD' at 7, approval at 8, execution at 9.
    const OLD_HASH = (h: number) => `old-${h}`;
    const oldChainEvents: ChainEvent[] = [
      {
        type: 'setup', blockHeight: 5, txHash: 'tx-setup',
        blockHash: OLD_HASH(5), parentHash: OLD_HASH(4),
        event: { parent: null, threshold: '2', numOwners: '2', networkId: 'net', ownersCommitment: 'commit-old' },
      },
      {
        type: 'setupOwner', blockHeight: 5, txHash: 'tx-setup',
        blockHash: OLD_HASH(5), parentHash: OLD_HASH(4),
        event: { owner: ownerA, index: '0' },
      },
      {
        type: 'setupOwner', blockHeight: 5, txHash: 'tx-setup',
        blockHash: OLD_HASH(5), parentHash: OLD_HASH(4),
        event: { owner: ownerB, index: '1' },
      },
      {
        type: 'proposal', blockHeight: 7, txHash: 'tx-prop-old',
        blockHash: OLD_HASH(7), parentHash: OLD_HASH(6),
        event: {
          proposalHash: 'OLD_PROPOSAL', proposer: ownerA, tokenId: '1', txType: '0',
          data: 'd', uid: 'u1', configNonce: '0', expirySlot: '1000',
          networkId: 'net', guardAddress: address, destination: '0', childAccount: null,
        },
      },
      {
        type: 'approval', blockHeight: 8, txHash: 'tx-appr-old',
        blockHash: OLD_HASH(8), parentHash: OLD_HASH(7),
        event: { proposalHash: 'OLD_PROPOSAL', approver: ownerA, approvalCount: '1' },
      },
      {
        type: 'execution', blockHeight: 9, txHash: 'tx-exec-old',
        blockHash: OLD_HASH(9), parentHash: OLD_HASH(8),
        event: { proposalHash: 'OLD_PROPOSAL' },
      },
    ];

    // Also seed the block 6 header on the old chain so fork detection has
    // something at 6 to compare against. Block 6 had no events, so ingestion
    // wouldn't create it.
    await prisma.blockHeader.create({
      data: { height: 6, blockHash: OLD_HASH(6), parentHash: OLD_HASH(5) },
    });

    // PHASE 1: ingest old chain.
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async () => oldChainEvents,
    }));
    await indexer.syncSingleContract(contract.id, address, 0, 9);
    await prisma.indexerCursor.upsert({
      where: { key: 'indexed_height' },
      create: { key: 'indexed_height', value: '9' },
      update: { value: '9' },
    });

    // Sanity-check old-chain state.
    const oldProposal = await prisma.proposal.findUniqueOrThrow({
      where: { contractId_proposalHash: { contractId: contract.id, proposalHash: 'OLD_PROPOSAL' } },
      include: { executions: true, _count: { select: { approvals: true } } },
    });
    expect(oldProposal.executions).toHaveLength(1);
    expect(oldProposal._count.approvals).toBe(1);

    // PHASE 2: detect reorg. New chain agrees through 6, diverges at 7.
    const NEW_HASH = (h: number) => `new-${h}`;
    const newChainHeaders = [
      { height: 4, blockHash: OLD_HASH(4), parentHash: OLD_HASH(3) },
      { height: 5, blockHash: OLD_HASH(5), parentHash: OLD_HASH(4) },
      { height: 6, blockHash: OLD_HASH(6), parentHash: OLD_HASH(5) },
      { height: 7, blockHash: NEW_HASH(7), parentHash: OLD_HASH(6) },
      { height: 8, blockHash: NEW_HASH(8), parentHash: NEW_HASH(7) },
      { height: 9, blockHash: NEW_HASH(9), parentHash: NEW_HASH(8) },
    ];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchBestChainHeaders: async () => newChainHeaders,
    }));
    const fork = await detectAndRollbackReorg(stubConfig);
    expect(fork).toBe(6);

    // Post-rollback: everything above 6 gone; setup state at 5 preserved.
    expect(await prisma.proposal.count()).toBe(0);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.proposalExecution.count()).toBe(0);
    expect(await prisma.blockHeader.count({ where: { height: { gt: 6 } } })).toBe(0);
    // EventRaw at block 5 (setup + two setupOwner) survives; blocks 7/8/9 gone.
    expect(await prisma.eventRaw.count({ where: { blockHeight: { gt: 6 } } })).toBe(0);
    expect(await prisma.eventRaw.count({ where: { blockHeight: { lte: 6 } } })).toBe(3);
    // ContractConfig rows from setup (all at block 5) survive; none above fork.
    expect(await prisma.contractConfig.count({ where: { validFromBlock: { gt: 6 } } })).toBe(0);
    expect(await prisma.contractConfig.count({ where: { validFromBlock: { lte: 6 } } })).toBeGreaterThan(0);
    // Contract row (discoveredAtBlock=4) survives.
    expect(await prisma.contract.count()).toBe(1);
    // Owners from setup still present (added at block 5 ≤ 6).
    expect(await prisma.ownerMembership.count()).toBe(2);

    // PHASE 3: ingest new chain. New proposal + approval at 7,8; owner B
    // removed at 9. No execution.
    const newChainEvents: ChainEvent[] = [
      {
        type: 'proposal', blockHeight: 7, txHash: 'tx-prop-new',
        blockHash: NEW_HASH(7), parentHash: OLD_HASH(6),
        event: {
          proposalHash: 'NEW_PROPOSAL', proposer: ownerA, tokenId: '1', txType: '0',
          data: 'd2', uid: 'u2', configNonce: '0', expirySlot: '1000',
          networkId: 'net', guardAddress: address, destination: '0', childAccount: null,
        },
      },
      {
        type: 'approval', blockHeight: 8, txHash: 'tx-appr-new',
        blockHash: NEW_HASH(8), parentHash: NEW_HASH(7),
        event: { proposalHash: 'NEW_PROPOSAL', approver: ownerA, approvalCount: '1' },
      },
      {
        type: 'ownerChange', blockHeight: 9, txHash: 'tx-owner-new',
        blockHash: NEW_HASH(9), parentHash: NEW_HASH(8),
        event: { owner: ownerB, added: '0', newNumOwners: '1', configNonce: '1' },
      },
    ];
    mock.module('../mina-client.js', () => ({
      ...minaClient,
      fetchDecodedContractEvents: async () => newChainEvents,
    }));
    await indexer.syncSingleContract(contract.id, address, 7, 9);

    // Final state asserts.
    const proposals = await prisma.proposal.findMany({
      include: { executions: true, _count: { select: { approvals: true } } },
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalHash).toBe('NEW_PROPOSAL');
    expect(proposals[0].executions).toHaveLength(0); // not executed on new chain
    expect(proposals[0]._count.approvals).toBe(1);
    // Globally: no stale OLD_PROPOSAL, no stale approvals (rollback wiped them).
    expect(await prisma.proposal.count({ where: { proposalHash: 'OLD_PROPOSAL' } })).toBe(0);
    expect(await prisma.approval.count()).toBe(1);
    expect(await prisma.proposalExecution.count()).toBe(0);

    // Owner collapse: ownerA added@5, ownerB added@5 then removed@9 → A active, B removed.
    const memberships = await prisma.ownerMembership.findMany({
      where: { contractId: contract.id },
      orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }, { id: 'desc' }],
    });
    const latestByAddr = new Map<string, typeof memberships[number]>();
    for (const m of memberships) {
      if (!latestByAddr.has(m.address)) latestByAddr.set(m.address, m);
    }
    expect(latestByAddr.get(ownerA)?.action).toBe('added');
    expect(latestByAddr.get(ownerB)?.action).toBe('removed');

    // ContractConfig latest snapshot reflects numOwners=1 after owner removal.
    const latestConfig = await prisma.contractConfig.findFirst({
      where: { contractId: contract.id },
      orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }],
    });
    expect(latestConfig?.numOwners).toBe(1);
    expect(latestConfig?.configNonce).toBe(1);
    // Threshold carried forward from setup snapshot (not changed by ownerChange).
    expect(latestConfig?.threshold).toBe(2);

    // BlockHeader rows match the new chain.
    const headers = await prisma.blockHeader.findMany({ orderBy: { height: 'asc' } });
    const heights = headers.map((h) => h.height);
    expect(heights).toContain(7);
    expect(heights).toContain(8);
    expect(heights).toContain(9);
    expect(headers.find((h) => h.height === 7)?.blockHash).toBe(NEW_HASH(7));
    expect(headers.find((h) => h.height === 9)?.blockHash).toBe(NEW_HASH(9));

    // PHASE 4: idempotency. Re-run new-chain ingest; row counts don't grow.
    const countsBefore = {
      eventRaw: await prisma.eventRaw.count(),
      proposal: await prisma.proposal.count(),
      approval: await prisma.approval.count(),
      ownerMembership: await prisma.ownerMembership.count(),
      contractConfig: await prisma.contractConfig.count(),
      blockHeader: await prisma.blockHeader.count(),
    };
    await indexer.syncSingleContract(contract.id, address, 7, 9);
    expect(await prisma.eventRaw.count()).toBe(countsBefore.eventRaw);
    expect(await prisma.proposal.count()).toBe(countsBefore.proposal);
    expect(await prisma.approval.count()).toBe(countsBefore.approval);
    expect(await prisma.ownerMembership.count()).toBe(countsBefore.ownerMembership);
    expect(await prisma.contractConfig.count()).toBe(countsBefore.contractConfig);
    expect(await prisma.blockHeader.count()).toBe(countsBefore.blockHeader);
  });
});
