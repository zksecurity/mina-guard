/**
 * Deterministic seed for the UI test suite.
 *
 * Writes the fixture world from fixtures.ts straight into the database the
 * uitest backend serves — no chain, no indexer. Statuses are NOT written
 * anywhere: they are derived at read time by the backend's real serializer
 * (deriveStatus / deriveInvalidReason / memo-match), so the seed only
 * arranges the inputs — execution rows, expirySlot vs the backend's fixed
 * latestSlot, and nonces vs the vault's ContractConfig counters.
 *
 * Run with DATABASE_URL pointing at a disposable database:
 *   DATABASE_URL=postgresql://... bun e2e/ui/seed.ts
 * (playwright.ui.config.ts runs it as part of the backend webServer command.)
 */

import { prisma } from '../../backend/src/db.js';
import { memoToField } from 'contracts';
import {
  WALLET,
  OWNER_2,
  OWNER_3,
  RECIPIENT,
  TREASURY,
  OPS_CHILD,
  PERSONAL,
  TREASURY_STATE,
  FIXED_LATEST_SLOT,
  PROPOSALS,
  MEMOS,
} from './fixtures';

const BASE_TIME = new Date('2026-07-01T00:00:00Z').getTime();
const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000);

async function clean(): Promise<void> {
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.contract.deleteMany();
}

interface VaultSpec {
  address: string;
  parent?: string;
  owners: string[];
  threshold: number;
  nonce: number;
  configNonce: number;
  childMultiSigEnabled: boolean;
  delegate?: string;
  /** Vault list orders by discoveredAt desc — 0 = newest = default-active. */
  listOrder: number;
}

async function seedVault(spec: VaultSpec): Promise<number> {
  const contract = await prisma.contract.create({
    data: {
      address: spec.address,
      parent: spec.parent ?? null,
      ready: true,
      discoveredAtBlock: 1,
      discoveredAt: at(-10 * spec.listOrder),
    },
  });

  await prisma.contractConfig.create({
    data: {
      contractId: contract.id,
      validFromBlock: 1,
      networkId: '0',
      threshold: spec.threshold,
      numOwners: spec.owners.length,
      nonce: spec.nonce,
      parentNonce: 0,
      configNonce: spec.configNonce,
      childMultiSigEnabled: spec.childMultiSigEnabled,
      delegate: spec.delegate ?? null,
      ownersCommitment: '12345678901234567890',
    },
  });

  await prisma.ownerMembership.createMany({
    data: spec.owners.map((address, index) => ({
      contractId: contract.id,
      address,
      action: 'added',
      index,
      validFromBlock: 1,
    })),
  });

  return contract.id;
}

interface ProposalSpec {
  hash: string;
  txType: string; // '0' transfer, '1' addOwner, ... (see backend event decoding)
  nonce: number;
  expirySlot?: number;
  memo?: string;
  /** When set, an execution row is created; the value becomes the executed
   *  tx's memo hash (equal to the proposal's for a match, different for a
   *  mismatch). Pass 'same' to reuse the proposal memoHash. */
  executedWithMemoHash?: 'same' | string;
  receivers?: Array<{ address: string; amount: string }>;
  approvers?: string[];
  createdAtBlock: number;
}

async function seedProposal(contractId: number, spec: ProposalSpec): Promise<void> {
  const memoHash = spec.memo ? memoToField(spec.memo).toString() : null;
  const executionMemoHash =
    spec.executedWithMemoHash === undefined
      ? null
      : spec.executedWithMemoHash === 'same'
        ? memoHash
        : spec.executedWithMemoHash;

  const proposal = await prisma.proposal.create({
    data: {
      contractId,
      proposalHash: spec.hash,
      proposer: WALLET,
      toAddress: spec.receivers?.[0]?.address ?? RECIPIENT,
      txType: spec.txType,
      data: '0',
      nonce: String(spec.nonce),
      configNonce: String(TREASURY_STATE.configNonce),
      expirySlot: String(spec.expirySlot ?? 0),
      networkId: '0',
      guardAddress: TREASURY,
      memo: spec.memo ?? null,
      memoHash,
      executionMemoHash,
      destination: 'local',
      createdAtBlock: spec.createdAtBlock,
      createdAt: at(spec.createdAtBlock / 10),
    },
  });

  if (spec.receivers?.length) {
    await prisma.proposalReceiver.createMany({
      data: spec.receivers.map((r, idx) => ({
        proposalId: proposal.id,
        idx,
        address: r.address,
        amount: r.amount,
      })),
    });
  }

  if (spec.approvers?.length) {
    await prisma.approval.createMany({
      data: spec.approvers.map((approver, i) => ({
        proposalId: proposal.id,
        approver,
        blockHeight: spec.createdAtBlock + 1,
        eventOrder: i,
      })),
    });
  }

  if (spec.executedWithMemoHash !== undefined) {
    await prisma.proposalExecution.create({
      data: {
        proposalId: proposal.id,
        blockHeight: spec.createdAtBlock + 10,
        txHash: `tx-${spec.hash}`,
      },
    });
  }
}

async function main(): Promise<void> {
  console.log('[seed-ui] cleaning');
  await clean();

  console.log('[seed-ui] seeding vaults');
  const treasuryId = await seedVault({
    address: TREASURY,
    owners: [WALLET, OWNER_2, OWNER_3],
    threshold: TREASURY_STATE.threshold,
    nonce: TREASURY_STATE.nonce,
    configNonce: TREASURY_STATE.configNonce,
    childMultiSigEnabled: true,
    listOrder: 0, // newest → default-active contract
  });
  await seedVault({
    address: OPS_CHILD,
    parent: TREASURY,
    owners: [WALLET],
    threshold: 1,
    nonce: 0,
    configNonce: 0,
    childMultiSigEnabled: true,
    listOrder: 1,
  });
  await seedVault({
    address: PERSONAL,
    owners: [WALLET],
    threshold: 1,
    nonce: 0,
    configNonce: 0,
    childMultiSigEnabled: false,
    delegate: RECIPIENT, // dashboard delegate-card display tests
    listOrder: 2,
  });

  console.log('[seed-ui] seeding proposals (one per derivable status)');
  // pending: nonce > TREASURY_STATE.nonce, no execution, no expiry
  await seedProposal(treasuryId, {
    hash: PROPOSALS.pendingTransfer,
    txType: '0',
    nonce: 6,
    memo: MEMOS.pendingTransfer,
    receivers: [
      { address: RECIPIENT, amount: '1000000000' },
      { address: OWNER_3, amount: '2500000000' },
    ],
    approvers: [WALLET],
    createdAtBlock: 1200,
  });
  await seedProposal(treasuryId, {
    hash: PROPOSALS.pendingAddOwner,
    txType: '1',
    nonce: 7,
    approvers: [WALLET, OWNER_2], // meets threshold=2 → executable
    createdAtBlock: 1300,
  });
  // executed: ProposalExecution row wins regardless of nonce
  await seedProposal(treasuryId, {
    hash: PROPOSALS.executedTransfer,
    txType: '0',
    nonce: 3,
    memo: MEMOS.executedTransfer,
    executedWithMemoHash: 'same', // memoExecutionMatch = true
    receivers: [{ address: RECIPIENT, amount: '5000000000' }],
    approvers: [WALLET, OWNER_2],
    createdAtBlock: 800,
  });
  await seedProposal(treasuryId, {
    hash: PROPOSALS.executedMemoMismatch,
    txType: '0',
    nonce: 2,
    memo: MEMOS.executedMemoMismatch,
    executedWithMemoHash: memoToField('tampered').toString(), // memoExecutionMatch = false
    receivers: [{ address: RECIPIENT, amount: '1000000000' }],
    approvers: [WALLET, OWNER_2],
    createdAtBlock: 600,
  });
  // expired: 0 < expirySlot < FIXED_LATEST_SLOT
  await seedProposal(treasuryId, {
    hash: PROPOSALS.expiredTransfer,
    txType: '0',
    nonce: 8,
    expirySlot: FIXED_LATEST_SLOT - 500,
    receivers: [{ address: RECIPIENT, amount: '750000000' }],
    approvers: [WALLET],
    createdAtBlock: 1400,
  });
  // invalidated: local destination with nonce <= TREASURY_STATE.nonce
  await seedProposal(treasuryId, {
    hash: PROPOSALS.invalidatedTransfer,
    txType: '0',
    nonce: 4,
    receivers: [{ address: RECIPIENT, amount: '1000000000' }],
    approvers: [WALLET],
    createdAtBlock: 1000,
  });

  console.log('[seed-ui] done');
}

void main()
  .catch((err) => {
    console.error('[seed-ui] failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
