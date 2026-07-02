import { Option, Poseidon, Field, Provable, PublicKey, Bool, Struct } from "o1js";
import { INITIAL_OWNER_CHAIN, MAX_OWNERS } from "./constants.js";

class PublicKeyOption extends Option(PublicKey) { }
const OwnerWitnessArray = Provable.Array(PublicKeyOption, MAX_OWNERS);
class OwnerWitness extends Struct({ owners: OwnerWitnessArray }) { }

function computeOwnerChain(owners: PublicKey[]): Field {
  let currentChain = INITIAL_OWNER_CHAIN;
  owners.forEach((pk) => {
    currentChain = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
  });
  return currentChain;
}

/**
 * Computes the owner-chain commitment from a fixed-size setup owner array,
 * folding in only the first `numOwners` slots (index < numOwners) and skipping
 * the PublicKey.empty() padding. Mirrors `computeOwnerChain` (which hashes only
 * real owners) so the result matches the commitment produced off-chain by
 * OwnerStore.getCommitment().
 *
 * Takes a raw PublicKey[] (caller passes SetupOwnersInput.owners) to avoid a
 * circular import with MinaGuard.ts where SetupOwnersInput is defined.
 *
 * Duplicate-owner and padding-is-empty coherence checks live in the companion
 * `assertCoherentSetupOwners`. Canonical ordering is intentionally NOT enforced
 * in-circuit (the off-chain order is base58, infeasible to reproduce cheaply
 * here); it is pinned for free by binding this result to the approved
 * `ownersCommitment` — any reordering changes the chain hash.
 */
function computeSetupOwnersChain(owners: PublicKey[], numOwners: Field): Field {
  let currentChain = INITIAL_OWNER_CHAIN;
  owners.forEach((pk, i) => {
    const active = Field(i).lessThan(numOwners);
    const next = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
    currentChain = Provable.if(active, next, currentChain);
  });
  return currentChain;
}

/**
 * Asserts the setup owner array is coherent w.r.t. `numOwners`:
 *  1. Every inactive slot (index >= numOwners) is PublicKey.empty() — padding
 *     must be empty (the dedup gate below intentionally ignores padding).
 *  2. No two active owners are equal — rejects a committed duplicate set
 *     (e.g. [A, A]), which the `commitment == ownersCommitment` bind cannot
 *     catch on its own.
 *
 * Ordering is NOT checked here: the canonical order is base58, which is
 * infeasible in-circuit, and ordering is already pinned by the separate
 * commitment-equality assert.
 */
function assertCoherentSetupOwners(owners: PublicKey[], numOwners: Field): void {
  const empty = PublicKey.empty();
  // hoist: one lessThan per index instead of recomputing inside the O(N^2) loop
  const active = owners.map((_, i) => Field(i).lessThan(numOwners));

  for (let i = 0; i < owners.length; i++) {

    // check if padding positions are indeed empty
    active[i].or(owners[i].equals(empty)).assertTrue('Padding slot must be empty');

    // pairwise dedup: slot i against all later active slots (O(N^2) overall)
    for (let j = i + 1; j < owners.length; j++) {
      owners[i].equals(owners[j]).and(active[i]).and(active[j])
        .assertFalse('Duplicate owner in setup list');
    }
  }
}

/**
 * Circuit to check membership of a public key in the owner list.
 * 
 * @param ownerCommitment
 * @param claimedOwner
 * @param ownersWitness
 */
function assertOwnerMembership(
  ownerCommitment: Field,
  claimedOwner: PublicKey,
  ownersWitness: OwnerWitness,
) {
  let found = Bool(false);
  let currentChain = INITIAL_OWNER_CHAIN;
  ownersWitness.owners.forEach(({ value: pk, isSome }) => {
    let newChain = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
    currentChain = Provable.if(isSome, newChain, currentChain);
    found = Provable.if(claimedOwner.equals(pk).and(isSome), Bool(true), found);
  });
  found.assertTrue('Claimed owner not a member of owners.');
  currentChain.assertEquals(ownerCommitment, 'Owner list mismatch');
}

/**
 * Circuit to add an owner. Checks that:
 * - Owner doesn't already exist
 * - Owner list witnessed matches the existing commitment
 *
 * When `insertAfter` is `none`, the new owner is prepended (inserted at the
 * start of the chain). When it is `some`, the new owner is inserted after
 * the specified key (which must exist in the list).
 *
 * IMPORTANT: Caller needs to check `valid` return value.
 * Caller needs to check size, insertion after last element will
 * break the commitment in the state irreversibly.
 *
 * @param ownerCommitment
 * @param ownerToAdd
 * @param ownersWitness Array of Option<PublicKey>, order needs to match commitment
 * @param insertAfter Option<PublicKey> – none to prepend, some(pk) to insert after pk
 * @returns The chain after the insertion, and a flag indicating if operation was succesfull
 */
function addOwnerToCommitment(
  ownerCommitment: Field,
  ownerToAdd: PublicKey,
  ownersWitness: OwnerWitness,
  insertAfter: PublicKeyOption
): [Field, Bool] {

  let currentChain = INITIAL_OWNER_CHAIN;
  let newChain = INITIAL_OWNER_CHAIN;

  let foundOwner = Bool(false);

  // when insertAfter is none, prepend
  const prepend = insertAfter.isSome.not();
  const prependHash = Poseidon.hash([newChain, ownerToAdd.x, ownerToAdd.isOdd.toField()]);
  newChain = Provable.if(prepend, prependHash, newChain);

  // if prepend, already "found" position. Else, start with false
  let foundPosition = prepend;

  ownersWitness.owners.forEach(({ value: pk, isSome }) => {

    let currentChainTemp = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
    currentChain = Provable.if(isSome, currentChainTemp, currentChain);

    let newChainTemp = Poseidon.hash([newChain, pk.x, pk.isOdd.toField()]);
    newChain = Provable.if(isSome, newChainTemp, newChain);

    const toAdd = Poseidon.hash([newChain, ownerToAdd.x, ownerToAdd.isOdd.toField()]);

    const isPosition = pk.equals(insertAfter.value).and(isSome).and(insertAfter.isSome);
    foundPosition = Provable.if(isPosition, Bool(true), foundPosition);
    newChain = Provable.if(isPosition, toAdd, newChain);

    foundOwner = Provable.if(pk.equals(ownerToAdd).and(isSome), Bool(true), foundOwner);
  });


  // return the new chain and a bool to indicate if operation was valid
  // this allows for more flexible handling by the caller
  return [newChain, foundOwner.not().and(foundPosition).and(currentChain.equals(ownerCommitment))];

}

/**
 * Circuit to remove an owner. Checks that:
 * - Owner to remove exists in the owners list
 * 
 * IMPORTANT: Caller needs to check `valid` return value.
 *  Caller needs the owner to be removed is not the only one
 * remaining.
 * 
 * @param ownerCommitment
 * @param ownerToRemove
 * @param ownersWitness Array of Option<PublicKey>, order needs to match commitment
 * @returns The chain after the removal, and a flag indicating if operation was succesfull
 */
function removeOwnerFromCommitment(
  ownerCommitment: Field,
  ownerToRemove: PublicKey,
  ownersWitness: OwnerWitness,
): [Field, Bool] {

  let currentChain = INITIAL_OWNER_CHAIN;
  let newChain = INITIAL_OWNER_CHAIN;

  let foundOwner = Bool(false);

  ownersWitness.owners.forEach(({ value: pk, isSome }) => {

    let currentChainTemp = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
    currentChain = Provable.if(isSome, currentChainTemp, currentChain);

    const isPosition = pk.equals(ownerToRemove).and(isSome);

    // to remove from chain, just skip ownerToRemove
    let newChainTemp = Poseidon.hash([newChain, pk.x, pk.isOdd.toField()]);
    newChain = Provable.if(isSome.and(isPosition.not()), newChainTemp, newChain);

    foundOwner = Provable.if(isPosition, Bool(true), foundOwner);
  });

  // return the new chain and a bool to indicate if operation was valid
  // this allows for more flexible handling by the caller
  return [newChain, foundOwner.and(currentChain.equals(ownerCommitment))];
}

export {
  OwnerWitness, OwnerWitnessArray, PublicKeyOption, computeOwnerChain, computeSetupOwnersChain,
  assertCoherentSetupOwners, assertOwnerMembership, addOwnerToCommitment, removeOwnerFromCommitment
};