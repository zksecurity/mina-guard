import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import { MinaGuardIndexer } from '../indexer.js';
import * as minaClient from '../mina-client.js';

const config = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
  archiveEndpoint: 'http://stub',
  archiveFallbackEndpoint: null,
  indexPollIntervalMs: 1000,
  indexStartHeight: 0,
  minaguardVkHash: '0',
  lightnetAccountManager: null,
  indexerMode: 'full' as const,
  discoveryBackend: 'archive' as const,
} as unknown as BackendConfig;

type TxStatus = Awaited<ReturnType<typeof minaClient.fetchZkappTxStatus>>;

/** Stubs the two mina-client lookups that pollPendingSubmissions consults. */
function stubLookups(opts: {
  txStatus: TxStatus;
  mempool: Set<string> | null;
}) {
  mock.module('../mina-client.js', () => ({
    ...minaClient,
    fetchZkappTxStatus: async (): Promise<TxStatus> => opts.txStatus,
    fetchMempoolHashes: async (): Promise<Set<string> | null> => opts.mempool,
  }));
}

async function clearAll() {
  await prisma.proposalExecution.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.contract.deleteMany();
}

/** Creates a proposal carrying a pending approve/execute tx, backdated past the
 *  20-minute grace window so pollPendingSubmissions treats it as drop-eligible. */
async function seedPendingProposal(
  kind: 'execute' | 'approve',
  txHash: string,
): Promise<number> {
  const contract = await prisma.contract.create({
    data: { address: PrivateKey.random().toPublicKey().toBase58(), ready: true },
  });
  const proposal = await prisma.proposal.create({
    data: {
      contractId: contract.id,
      proposalHash: `hash-${txHash}`,
      createdAtBlock: 1,
      ...(kind === 'execute'
        ? { lastExecuteTxHash: txHash }
        : { lastApproveTxHash: txHash }),
    },
  });
  // @updatedAt is auto-managed on write, so backdate it with raw SQL to make the
  // submission look older than DROPPED_TX_GRACE_MS (20 min).
  await prisma.$executeRawUnsafe(
    `UPDATE "Proposal" SET "updatedAt" = NOW() - INTERVAL '30 minutes' WHERE id = $1`,
    proposal.id,
  );
  return proposal.id;
}

async function pollOnce() {
  const indexer = new MinaGuardIndexer(config);
  // pollPendingSubmissions is private but self-contained (reads this.config +
  // prisma only), so we drive it directly without the full start() tick.
  await (indexer as unknown as { pollPendingSubmissions(): Promise<void> }).pollPendingSubmissions();
}

async function errorOf(id: number): Promise<{ execute: string | null; approve: string | null }> {
  const p = await prisma.proposal.findUniqueOrThrow({
    where: { id },
    select: { lastExecuteError: true, lastApproveError: true },
  });
  return { execute: p.lastExecuteError, approve: p.lastApproveError };
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

describe('pollPendingSubmissions: dropped-tx detection', () => {
  // Regression: a tx that was actually included leaves the mempool, but if the
  // (heavy) bestChain lookup fails it returns 'unknown'. That must NOT be
  // treated as confirmed-absent — otherwise a successful tx gets falsely marked
  // dropped and the signer lock is released on a transient network blip.
  test("does not mark dropped when the bestChain lookup fails ('unknown')", async () => {
    const id = await seedPendingProposal('execute', 'tx-included');
    // status 'unknown' = lookup failed; mempool succeeds but the tx already left
    // it (because it was included on-chain).
    stubLookups({ txStatus: { status: 'unknown' }, mempool: new Set<string>() });

    await pollOnce();

    expect((await errorOf(id)).execute).toBeNull();
  });

  test("does not mark dropped on the approve path when the lookup fails ('unknown')", async () => {
    const id = await seedPendingProposal('approve', 'tx-approve-included');
    stubLookups({ txStatus: { status: 'unknown' }, mempool: new Set<string>() });

    await pollOnce();

    expect((await errorOf(id)).approve).toBeNull();
  });

  // Positive control: a genuinely dropped tx — bestChain positively reports
  // 'pending' (scanned, not there) and it's absent from the mempool — must still
  // be detected so the signer isn't locked out forever.
  test("marks dropped when bestChain is positively 'pending' and tx is absent from mempool", async () => {
    const id = await seedPendingProposal('execute', 'tx-dropped');
    stubLookups({ txStatus: { status: 'pending' }, mempool: new Set<string>() });

    await pollOnce();

    expect((await errorOf(id)).execute).toBe('Transaction was dropped from the mempool');
  });

  // Fail-safe on the mempool side: if the mempool fetch itself fails (null), we
  // also abstain even when bestChain says 'pending'.
  test('does not mark dropped when the mempool fetch fails (null)', async () => {
    const id = await seedPendingProposal('execute', 'tx-mempool-down');
    stubLookups({ txStatus: { status: 'pending' }, mempool: null });

    await pollOnce();

    expect((await errorOf(id)).execute).toBeNull();
  });
});
