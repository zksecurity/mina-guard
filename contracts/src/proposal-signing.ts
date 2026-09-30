import { Field, Poseidon } from 'o1js';

/** Keep proposal identity and memo commitments separate from signing actions. */
export const PROPOSAL_HASH_PREFIX = 'mina-guard-proposal';
export const MEMO_HASH_PREFIX = 'mina-guard-memo';

/** Network, vault and operation are already committed by proposalHash. */
export function proposalSigningMessage(proposalHash: Field, action: 'propose' | 'approve'): Field {
  if (action !== 'propose' && action !== 'approve') throw new Error('Unsupported proposal signing action');
  return Poseidon.hashWithPrefix(
    action === 'propose' ? 'mina-guard-propose' : 'mina-guard-approve',
    [proposalHash],
  );
}
