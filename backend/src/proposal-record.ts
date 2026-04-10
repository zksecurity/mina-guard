import type { Proposal, ProposalReceiver } from '@prisma/client';
import { memoToField } from 'contracts';

export interface ProposalReceiverRecord {
  index: number;
  address: string;
  amount: string;
}

/** Verdict on whether the off-chain proposer memo matches the hash the
 *  executor committed on-chain in the execution event.
 *  - `null`  — not yet computable (pending, no proposer memo, or
 *              executionMemoHash not yet observed).
 *  - `true`  — proposer memo, when hashed, equals the executor's memoHash.
 *  - `false` — proposer memo hashes to something different from what the
 *              executor committed. */
export type MemoExecutionMatch = boolean | null;

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
  memo: string | null;
  memoExecutionMatch: MemoExecutionMatch;
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

type ProposalWithReceivers = Proposal & {
  receivers: ProposalReceiver[];
};

/** Derives the match verdict comparing the proposer's plaintext memo against
 *  the hash of the executor's outer tx memo observed on-chain.
 *
 *  - `null` (indeterminate, UI shows yellow warning) iff we haven't yet seen
 *    an execution event for this proposal — i.e. the row is still pending.
 *    Once executed, the indexer always writes a non-null executionMemoHash
 *    (at minimum '0' for an empty tx memo), so this branch maps 1:1 to
 *    "not yet executed".
 *  - Otherwise, a null proposer memo is treated as the empty string, matching
 *    the indexer's null → '' normalization for the tx memo. This yields:
 *      (null proposer, empty executor)    → match   → UI shows no icon
 *      (null proposer, non-empty executor) → mismatch → red ✗
 *      (memo proposer, empty executor)    → mismatch → red ✗
 *      (memo proposer, matching executor) → match   → green ✓ */
function computeMemoExecutionMatch(
  memo: string | null,
  executionMemoHash: string | null
): MemoExecutionMatch {
  if (executionMemoHash == null) return null;
  const proposerHash = memoToField(memo ?? '').toString();
  const match = proposerHash === executionMemoHash;
  return match;
}

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
    memo: proposal.memo,
    memoExecutionMatch: computeMemoExecutionMatch(proposal.memo, proposal.executionMemoHash),
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
