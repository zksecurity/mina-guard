/**
 * When an approval applies, the indexer clears the proposal's recorded approve
 * hash if it is this transaction's, or if the recorded transaction already
 * failed: a failed transaction never applies, so this approval is a retry,
 * one the submissions route may have refused to record.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import { MinaGuardIndexer } from '../indexer.js';
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

const PROPOSAL = '1234567890';
const APPROVER = PrivateKey.random().toPublicKey().toBase58();

const approval = (txHash: string): ChainEvent => ({
  type: 'approval', blockHeight: 7, txHash, txMemo: null, blockHash: 'hash-7', parentHash: 'hash-6',
  event: { proposalHash: PROPOSAL, approver: APPROVER, approvalCount: '1', approvalRoot: '0', voteNullifierRoot: '0' },
});

async function clearAll() {
  await prisma.approval.deleteMany();
  await prisma.proposal.deleteMany();
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

type Recorded = { lastApproveTxHash: string | null; lastApproveError: string | null };

/** Seeds a proposal with `recorded` approve tracking, applies `event`, and returns the tracking after. */
async function applyTo(recorded: Recorded, event: ChainEvent): Promise<Recorded> {
  const address = PrivateKey.random().toPublicKey().toBase58();
  const contract = await prisma.contract.create({ data: { address, discoveredAtBlock: 1, permissionsVerified: true } });
  const proposal = await prisma.proposal.create({
    data: { contractId: contract.id, proposalHash: PROPOSAL, createdAtBlock: 1, ...recorded },
  });
  stubMinaClient(() => ({ fetchDecodedContractEvents: async () => [event], fetchOnChainState: async () => null }));
  await new MinaGuardIndexer(stubConfig).syncSingleContract(contract.id, address, 0, 20);
  return prisma.proposal.findUniqueOrThrow({
    where: { id: proposal.id }, select: { lastApproveTxHash: true, lastApproveError: true },
  });
}

const cleared: Recorded = { lastApproveTxHash: null, lastApproveError: null };

describe('applying an approval', () => {
  test('clears its own recorded hash', async () => {
    expect(await applyTo({ lastApproveTxHash: 'tx-a', lastApproveError: null }, approval('tx-a'))).toEqual(cleared);
  });

  test('clears a recorded hash that already failed, whichever transaction this is', async () => {
    expect(await applyTo({ lastApproveTxHash: 'tx-a', lastApproveError: 'dropped' }, approval('tx-b'))).toEqual(cleared);
  });

  test('leaves another transaction still in flight alone', async () => {
    const live = { lastApproveTxHash: 'tx-a', lastApproveError: null };
    expect(await applyTo(live, approval('tx-b'))).toEqual(live);
  });
});
