import type { Proposal, ProposalReceiver } from '@prisma/client';

export interface ProposalReceiverRecord {
  index: number;
  address: string;
  amount: string;
}

export interface SerializedProposalRecord {
  proposalHash: string;
  proposer: string | null;
  toAddress: string | null;
  tokenId: string | null;
  txType: string | null;
  data: string | null;
  uid: string | null;
  configNonce: string | null;
  expiryBlock: string | null;
  networkId: string | null;
  guardAddress: string | null;
  status: string;
  approvalCount: number;
  createdAtBlock: number | null;
  executedAtBlock: number | null;
  createdAt: Date;
  updatedAt: Date;
  receivers: ProposalReceiverRecord[];
  recipientCount: number;
  totalAmount: string | null;
}

type ProposalWithReceivers = Proposal & {
  receivers: ProposalReceiver[];
};

/** Converts Prisma proposal rows into the API shape expected by the UI. */
export function serializeProposalRecord(
  proposal: ProposalWithReceivers
): SerializedProposalRecord {
  const receivers = proposal.receivers
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((receiver) => ({
      index: receiver.idx,
      address: receiver.address,
      amount: receiver.amount,
    }));

  const totalAmount = receivers.length > 0
    ? receivers.reduce((sum, receiver) => sum + BigInt(receiver.amount), 0n).toString()
    : null;

  return {
    proposalHash: proposal.proposalHash,
    proposer: proposal.proposer,
    toAddress: proposal.toAddress,
    tokenId: proposal.tokenId,
    txType: proposal.txType,
    data: proposal.data,
    uid: proposal.uid,
    configNonce: proposal.configNonce,
    expiryBlock: proposal.expiryBlock,
    networkId: proposal.networkId,
    guardAddress: proposal.guardAddress,
    status: proposal.status,
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
