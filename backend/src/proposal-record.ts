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
  createdAt: Date;
  updatedAt: Date;
  receivers: ProposalReceiverRecord[];
  recipientCount: number;
  totalAmount: string | null;
}

export type ProposalWithDerived = Proposal & {
  receivers: ProposalReceiver[];
  executions: { blockHeight: number; txHash: string | null }[];
  _count: { approvals: number };
};

/**
 * Derives proposal status from the append-only schema.
 *
 * `executed` iff a ProposalExecution row exists. Else `expired` iff the chain
 * has moved past `expiryBlock`. Else `pending`. `latestHeight` is the current
 * chain tip reported by the indexer.
 */
function deriveStatus(proposal: Proposal, executed: boolean, latestHeight: number): string {
  if (executed) return 'executed';
  const expiry = Number(proposal.expiryBlock ?? '0');
  if (Number.isFinite(expiry) && expiry > 0 && latestHeight > expiry) return 'expired';
  return 'pending';
}

/** Converts Prisma proposal rows into the API shape expected by the UI. */
export function serializeProposalRecord(
  proposal: ProposalWithDerived,
  latestHeight: number,
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

  const execution = proposal.executions[0] ?? null;
  const status = deriveStatus(proposal, execution !== null, latestHeight);

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
    status,
    invalidReason: null, // TODO: add it back to schema?
    approvalCount: proposal._count.approvals,
    createdAtBlock: proposal.createdAtBlock,
    executedAtBlock: execution?.blockHeight ?? null,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    receivers,
    recipientCount: receivers.length,
    totalAmount,
  };
}
