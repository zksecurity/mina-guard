import { MerkleMap, Poseidon, Field } from "o1js";

export const MAX_OWNERS = 20;
export const INITIAL_SIGNER_CHAIN = Poseidon.hashWithPrefix('signer-chain', []);
export const INITIAL_OWNER_CHAIN = Poseidon.hashWithPrefix('owner-chain', []);

export const PROPOSED_MARKER = Field(1);
export const EXECUTED_MARKER = Field(0).sub(1);
export const EMPTY_MERKLE_MAP_ROOT = new MerkleMap().getRoot();

export const TxType = {
  TRANSFER: Field(0),
  ADD_OWNER: Field(1),
  REMOVE_OWNER: Field(2),
  CHANGE_THRESHOLD: Field(3),
  SET_DELEGATE: Field(4),
};