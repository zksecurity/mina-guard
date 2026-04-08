import { MerkleMap, Poseidon, Field } from "o1js";

export const MAX_OWNERS = 20;

// Hard limit: each receiver creates an AccountUpdate via this.send(), and Mina's
// transaction cost budget caps out at 9. At 10 receivers the transaction fails with
// "transaction is too expensive" during proving.
export const MAX_RECEIVERS = 9;
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
  CREATE_CHILD: Field(5),
  ALLOCATE_CHILD: Field(6),
  RECLAIM_CHILD: Field(7),
  DESTROY_CHILD: Field(8),
  TOGGLE_POLICY: Field(9),
};

export const Destination = {
  LOCAL: Field(0),
  REMOTE: Field(1),
};
