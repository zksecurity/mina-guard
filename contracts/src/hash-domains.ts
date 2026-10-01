import { Field, Poseidon, PublicKey } from 'o1js';

/** Each commitment has its own tag so equal field lists cannot cross purposes. */
export function ownerChainLink(previous: Field, owner: PublicKey): Field {
  return Poseidon.hashWithPrefix('owner-link', [previous, owner.x, owner.isOdd.toField()]);
}

export function voteNullifierKey(proposalHash: Field, owner: PublicKey): Field {
  return Poseidon.hashWithPrefix('vote-nullifier', [proposalHash, ...owner.toFields()]);
}

export function childConfigHash(ownersCommitment: Field, threshold: Field, numOwners: Field): Field {
  return Poseidon.hashWithPrefix('child-config', [ownersCommitment, threshold, numOwners]);
}
