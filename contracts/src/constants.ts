import { Poseidon } from "o1js";

export const MAX_OWNERS = 20;
export const INITIAL_SIGNER_CHAIN = Poseidon.hashWithPrefix('signer-chain', []);
export const INITIAL_OWNER_CHAIN = Poseidon.hashWithPrefix('owner-chain', []);