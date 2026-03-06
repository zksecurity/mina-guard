import {
    Field, PublicKey, Poseidon
} from 'o1js';

export function ownerKey(owner: PublicKey): Field {
  return Poseidon.hash(owner.toFields());
}
