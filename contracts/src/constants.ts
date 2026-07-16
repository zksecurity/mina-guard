import { MerkleMap, Poseidon, Field } from "o1js";

// Compile-time network domain separator baked into every proposal hash.
// Produces distinct VKs per network so a proposal signed on testnet cannot be
// replayed on mainnet (and vice versa) even if the guard address, owner set,
// and app-level networkId are identical.
//
// Selecting the domain differs by build context:
//   - Node (offline-cli binary, `vk-hash compile`, CI, tests): set
//     MINA_NETWORK_DOMAIN=mainnet. These have a real process.env at runtime.
//   - Browser bundles (the Next UI / desktop app worker): set
//     NEXT_PUBLIC_MINA_NETWORK_DOMAIN=mainnet. Next only inlines NEXT_PUBLIC_*
//     vars into client code; a bare env var is dropped (process.env is {} in
//     the browser) and would silently resolve to testnet. The NEXT_PUBLIC_ form
//     wins when both are set, which only happens during a Next build.
// Anything else (or unset) is treated as testnet.
export const NETWORK_DOMAIN = Field(
  (process.env.NEXT_PUBLIC_MINA_NETWORK_DOMAIN ?? process.env.MINA_NETWORK_DOMAIN) === 'mainnet'
    ? 1n
    : 2n,
);

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
  ENABLE_CHILD_MULTI_SIG: Field(9),
};

export const Destination = {
  LOCAL: Field(0),
  REMOTE: Field(1),
};
