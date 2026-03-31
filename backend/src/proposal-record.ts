import { prisma } from './db.js';

export interface ProposalReceiverRecord {
  index: number;
  address: string;
  amount: string;
}

export interface SerializedProposalRecord {
  proposalHash: string;
  proposer: string | null;
  toAddress: string | null;
  amount: string | null;
  tokenId: string | null;
  txType: string | null;
  data: string | null;
  uid: string | null;
  configNonce: string | null;
  expiryBlock: string | null;
  networkId: string | null;
  guardAddress: string | null;
  status: string;
  origin: string;
  approvalCount: number;
  createdAtBlock: number | null;
  executedAtBlock: number | null;
  createdAt: Date;
  updatedAt: Date;
  receivers: ProposalReceiverRecord[];
  recipientCount: number;
  totalAmount: string | null;
}

type ProposalWithReceivers = Awaited<ReturnType<typeof prisma.proposal.findFirst>> & {
  receivers: Array<{ idx: number; address: string; amount: string }>;
};

/** Converts Prisma proposal rows into the API shape expected by the UI. */
export function serializeProposalRecord(
  proposal: ProposalWithReceivers
): SerializedProposalRecord {
  const storedReceivers = proposal.receivers
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((receiver) => ({
      index: receiver.idx,
      address: receiver.address,
      amount: receiver.amount,
    }));
  const receivers = storedReceivers.length > 0
    ? storedReceivers
    : proposal.txType === '0' && proposal.toAddress && proposal.amount
      ? [{ index: 0, address: proposal.toAddress, amount: proposal.amount }]
      : [];

  const totalAmount = receivers.length > 0
    ? receivers.reduce((sum, receiver) => sum + BigInt(receiver.amount), 0n).toString()
    : null;

  return {
    proposalHash: proposal.proposalHash,
    proposer: proposal.proposer,
    toAddress: proposal.toAddress,
    amount: proposal.amount,
    tokenId: proposal.tokenId,
    txType: proposal.txType,
    data: proposal.data,
    uid: proposal.uid,
    configNonce: proposal.configNonce,
    expiryBlock: proposal.expiryBlock,
    networkId: proposal.networkId,
    guardAddress: proposal.guardAddress,
    status: proposal.status,
    origin: proposal.origin,
    approvalCount: proposal.approvalCount,
    createdAtBlock: proposal.createdAtBlock,
    executedAtBlock: proposal.executedAtBlock,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    receivers,
    recipientCount: receivers.length,
    totalAmount,
  };
}

/**
 * Backfills receiver rows for legacy transfer proposals that predate the
 * receiver-array schema. Safe to run repeatedly.
 */
export async function backfillLegacyTransferReceivers(): Promise<void> {
  const legacyTransfers = await prisma.proposal.findMany({
    where: {
      txType: '0',
      toAddress: { not: null },
      amount: { not: null },
      receivers: { none: {} },
    },
    select: {
      id: true,
      toAddress: true,
      amount: true,
    },
  });

  for (const proposal of legacyTransfers) {
    if (!proposal.toAddress || !proposal.amount) continue;
    await prisma.proposalReceiver.create({
      data: {
        proposalId: proposal.id,
        idx: 0,
        address: proposal.toAddress,
        amount: proposal.amount,
      },
    });
  }
}
