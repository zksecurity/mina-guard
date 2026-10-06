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
