import { Option, Poseidon, Field, Provable, PublicKey, Bool } from "o1js";
import { INITIAL_OWNER_CHAIN, MAX_OWNERS } from "./constants";

class PublicKeyOption extends Option(PublicKey) { }
type OwnerWitness = PublicKeyOption[];
const OwnerWitness = Provable.Array(PublicKeyOption, MAX_OWNERS);

function computeOwnerChain(owners: PublicKey[]): Field {
  let currentChain = INITIAL_OWNER_CHAIN;
  owners.forEach((pk) => {
    currentChain = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
  });
  return currentChain;
}

/**
 * Circuit to check membership of a public key in the owner list.
 * 
 * @param ownerCommitment 
 * @param claimedOwner 
 * @param ownersWitness 
 * @param shouldBeOwner 
 */
function assertOwnerMembership(
  ownerCommitment: Field,
  claimedOwner: PublicKey,
  ownersWitness: OwnerWitness,
  shouldBeOwner: Bool
) {
  let found = Bool(false);
  let currentChain = INITIAL_OWNER_CHAIN;
  ownersWitness.forEach(({ value: pk, isSome }) => {

    let newChain = Poseidon.hash([currentChain, pk.x, pk.isOdd.toField()]);
    currentChain = Provable.if(isSome, newChain, currentChain);
    found = Provable.if(claimedOwner.equals(pk).and(isSome), Bool(true), found);

  });
  found.assertEquals(shouldBeOwner, 'Owner membership check failed');
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

  ownersWitness.forEach(({ value: pk, isSome }) => {

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

  ownersWitness.forEach(({ value: pk, isSome }) => {

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
  OwnerWitness, PublicKeyOption, computeOwnerChain, assertOwnerMembership,
  addOwnerToCommitment, removeOwnerFromCommitment
};