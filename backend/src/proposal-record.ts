import type { Proposal, ProposalReceiver } from '@prisma/client';
import { memoToField } from 'contracts';

export interface ProposalReceiverRecord {
  index: number;
  address: string;
  amount: string;
}

export type MemoMatch = boolean | null;

export type InvalidReason = 'config_nonce_stale' | 'proposal_nonce_stale';

/** Snapshot of a contract's current on-chain counters, derived from the latest
 *  ContractConfig row. Used to compute per-proposal `invalidReason` at read
 *  time — no persistence, no rollback bookkeeping. */
export type ContractState = {
  nonce: number | null;
  parentNonce: number | null;
  configNonce: number | null;
};

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
  memo: string | null;
  memoHash: string | null;
  proposalMemoMatch: MemoMatch;
  memoExecutionMatch: MemoMatch;
  destination: string | null;
  childAccount: string | null;
  status: string;
  invalidReason: InvalidReason | null;
  approvalCount: number;
  createdAtBlock: number | null;
  executedAtBlock: number | null;
  lastApproveTxHash: string | null;
  lastExecuteTxHash: string | null;
  lastApproveError: string | null;
  lastExecuteError: string | null;
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

type ProposalInvalidInput = Pick<Proposal, 'nonce' | 'configNonce' | 'destination' | 'txType'>;

/**
 * Pure check: is this proposal invalidated by the current contract state?
 *
 * Config-stale takes precedence over nonce-stale (matches on-chain assert
 * ordering and prior indexer logic). CREATE_CHILD (txType='5') bypasses
 * nonce-stale entirely — its nonce is structural (always 0), not sequential.
 */
export function deriveInvalidReason(
  proposal: ProposalInvalidInput,
  parent: ContractState | null,
  child: ContractState | null,
): InvalidReason | null {
  if (parent?.configNonce != null && proposal.configNonce != null) {
    const parsedConfig = Number(proposal.configNonce);
    if (Number.isFinite(parsedConfig) && parsedConfig < parent.configNonce) {
      return 'config_nonce_stale';
    }
  }

  if (proposal.txType === '5') return null;

  if (proposal.nonce == null) return null;
  const parsedNonce = Number(proposal.nonce);
  if (!Number.isFinite(parsedNonce)) return null;

  const isRemote = proposal.destination === 'remote';
  if (!isRemote) {
    if (parent?.nonce != null && parsedNonce <= parent.nonce) {
      return 'proposal_nonce_stale';
    }
    return null;
  }

  if (child?.parentNonce != null && parsedNonce <= child.parentNonce) {
    return 'proposal_nonce_stale';
  }
  return null;
}

/**
 * Derives proposal status from the append-only schema plus read-time checks.
 *
 * Precedence: `executed` (ProposalExecution row) > `expired` (latestHeight
 * past expiryBlock) > `invalidated` (deriveInvalidReason returned non-null)
 * > `pending`.
 */
function deriveStatus(
  proposal: Proposal,
  executed: boolean,
  latestHeight: number,
  invalidReason: InvalidReason | null,
): string {
  if (executed) return 'executed';
  const expiry = Number(proposal.expiryBlock ?? '0');
  if (Number.isFinite(expiry) && expiry > 0 && latestHeight > expiry) return 'expired';
  if (invalidReason !== null) return 'invalidated';
  return 'pending';
}

function computeProposalMemoMatch(
  memo: string | null,
  memoHash: string | null,
): MemoMatch {
  if (memo == null || memoHash == null) return null;
  if (memoHash === '0') return null;
  return memoToField(memo).toString() === memoHash;
}

function computeMemoExecutionMatch(
  memoHash: string | null,
  executionMemoHash: string | null,
): MemoMatch {
  if (executionMemoHash == null) return null;
  if (memoHash == null) return null;
  return memoHash === executionMemoHash;
}

/** Converts Prisma proposal rows into the API shape expected by the UI. */
export function serializeProposalRecord(
  proposal: ProposalWithDerived,
  latestHeight: number,
  parentState: ContractState | null = null,
  childState: ContractState | null = null,
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
  const invalidReason = deriveInvalidReason(proposal, parentState, childState);
  const status = deriveStatus(proposal, execution !== null, latestHeight, invalidReason);

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
    memo: proposal.memo,
    memoHash: proposal.memoHash,
    proposalMemoMatch: computeProposalMemoMatch(proposal.memo, proposal.memoHash),
    memoExecutionMatch: computeMemoExecutionMatch(proposal.memoHash, proposal.executionMemoHash),
    destination: proposal.destination,
    childAccount: proposal.childAccount,
    status,
    invalidReason,
    approvalCount: proposal._count.approvals,
    createdAtBlock: proposal.createdAtBlock,
    executedAtBlock: execution?.blockHeight ?? null,
    lastApproveTxHash: proposal.lastApproveTxHash,
    lastExecuteTxHash: proposal.lastExecuteTxHash,
    lastApproveError: proposal.lastApproveError,
    lastExecuteError: proposal.lastExecuteError,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    receivers,
    recipientCount: receivers.length,
    totalAmount,
  };
}
