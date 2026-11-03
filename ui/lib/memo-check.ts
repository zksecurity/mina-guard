import type { Proposal } from '@/lib/types';

export type MemoBadge = 'match' | 'mismatch' | 'proposalMismatch' | null;

/**
 * Picks the memo badge for a proposal. Whether the memo text matches the
 * signed memo hash comes from a hash this browser computed, not from the
 * server's flag; until that check finishes, no badge is shown. The
 * execution-memo flag still comes from the server, because the browser does
 * not have the executed transaction's memo.
 */
export function memoBadge(
  proposal: Pick<Proposal, 'memoHash' | 'status' | 'memoExecutionMatch'>,
  localMemoMatch: boolean | null,
): MemoBadge {
  if (proposal.memoHash == null || localMemoMatch === null) return null;
  if (proposal.status === 'executed') {
    return localMemoMatch && proposal.memoExecutionMatch === true ? 'match' : 'mismatch';
  }
  return localMemoMatch ? null : 'proposalMismatch';
}

/** Error text shown when an execution's memo does not match the approved memo. */
export const EXECUTION_MEMO_MISMATCH =
  'The memo text from the server does not match the memo the owners approved. ' +
  'Execution stopped so the transaction is not sent with a different memo.';

/**
 * Stops an execution before it is built when the memo text that will be put
 * on the transaction does not hash to the memo hash the owners approved.
 * Owners approve only the hash; the memo text itself comes from the server.
 * Without this check a tampered server could keep the approved proposal and
 * swap its memo (for example an exchange deposit tag), and the proof would
 * still verify. A missing memo is treated as the empty memo, which is what
 * the transaction would carry.
 *
 * `hashMemo` is the proposal memo hash function (contracts `memoToField`),
 * passed in so this module does not load o1js on the main page.
 */
export function assertExecutionMemoMatches(
  memo: string | null | undefined,
  approvedMemoHash: string,
  hashMemo: (memo: string) => string,
): void {
  if (hashMemo(memo ?? '') !== approvedMemoHash) throw new Error(EXECUTION_MEMO_MISMATCH);
}
