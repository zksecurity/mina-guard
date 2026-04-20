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
  nonce: string | null;
  configNonce: string | null;
  expiryBlock: string | null;
  networkId: string | null;
  guardAddress: string | null;
  destination: string | null;
  childAccount: string | null;
  status: string;
  invalidReason: string | null;
  approvalCount: number;
  createdAtBlock: number | null;
  executedAtBlock: number | null;
  lastApproveError: string | null;
  lastExecuteError: string | null;
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
    .sort((a: ProposalReceiver, b: ProposalReceiver) => a.idx - b.idx)
    .map((receiver: ProposalReceiver) => ({
      index: receiver.idx,
      address: receiver.address,
      amount: receiver.amount,
    }));

  const totalAmount = receivers.length > 0
    ? receivers.reduce((sum: bigint, receiver: ProposalReceiverRecord) => sum + BigInt(receiver.amount), 0n).toString()
    : null;

  return {
    proposalHash: proposal.proposalHash,
    proposer: proposal.proposer,
    toAddress: proposal.toAddress,
    tokenId: proposal.tokenId,
    txType: proposal.txType,
    data: proposal.data,
    nonce: proposal.nonce,
    configNonce: proposal.configNonce,
    expiryBlock: proposal.expiryBlock,
    networkId: proposal.networkId,
    guardAddress: proposal.guardAddress,
    destination: proposal.destination,
    childAccount: proposal.childAccount,
    status: proposal.status,
    invalidReason: proposal.invalidReason,
    approvalCount: proposal.approvalCount,
    createdAtBlock: proposal.createdAtBlock,
    executedAtBlock: proposal.executedAtBlock,
    lastApproveError: proposal.lastApproveError,
    lastExecuteError: proposal.lastExecuteError,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    receivers,
    recipientCount: receivers.length,
    totalAmount,
  };
}
