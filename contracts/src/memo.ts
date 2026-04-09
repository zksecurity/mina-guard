import { Field, Poseidon } from 'o1js';

/**
 * Encodes a memo string as the Field commitment stored in
 * `TransactionProposal.memoHash`.
 *
 * Shared between the UI (when building a proposal to sign) and the backend
 * (when verifying a submitted plaintext memo against its claimed memoHash),
 * so both sides MUST derive the commitment the same way.
 *
 * Empty string → `Field(0)` (the "no memo" convention).
 */
export function memoToField(memo: string): Field {
  if (memo.length === 0) return Field(0);
  const bytes = new TextEncoder().encode(memo);
  return Poseidon.hash(Array.from(bytes, (b) => Field(b)));
}
