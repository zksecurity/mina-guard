/** A verified non-empty approval entry means this proposal was already created. */
export function requireUnregisteredProposal(proposalHash: string, approvalValue: bigint): void {
  if (approvalValue !== 0n) throw new Error(`MINAGUARD_PROPOSAL_EXISTS:${proposalHash}`);
}

/** Keep unrelated failures out of the existing-proposal recovery panel. */
export function existingProposalHash(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^MINAGUARD_PROPOSAL_EXISTS:([0-9]+)$/.exec(error.message)?.[1] ?? null;
}
