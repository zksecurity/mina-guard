# MinaGuard Architecture

MinaGuard is a multisig vault zkApp for Mina, built with o1js. It manages shared funds via a quorum of owner signatures verified inside zero-knowledge circuits. The contract supports two execution flows: a **multi-step on-chain flow** (propose → approve → execute) and a **batch signature flow** where all signatures are collected off-chain and verified in a single transaction.

## File Layout

| File | Purpose |
| ---- | ------- |
| `MinaGuard.ts` | Contract class, types (structs), events |
| `constants.ts` | `MAX_OWNERS`, markers, `TxType` enum, chain hash prefixes |
| `storage.ts` | Off-chain stores: `OwnerStore`, `ApprovalStore`, `VoteNullifierStore` |
| `list-commitment.ts` | Owner chain hash circuits: membership proof, add, remove |
| `batch-verify.ts` | Batch signature verification circuit |
| `utils.ts` | `ownerKey()` helper (`Poseidon.hash(owner.toFields())`) |
| `index.ts` | Public exports |

## On-Chain State (8 Fields)

Mina limits zkApps to 8 state fields. MinaGuard uses all 8:

| Slot | Field | Purpose |
| ---- | ----- | ------- |
| 0 | `ownersCommitment` | Chain hash of the ordered owner list |
| 1 | `threshold` | Minimum approvals required to execute any proposal |
| 2 | `numOwners` | Current owner count |
| 3 | `proposalCounter` | Monotonic counter; each proposal gets a unique ID |
| 4 | `voteNullifierRoot` | MerkleMap root preventing double-voting |
| 5 | `approvalRoot` | MerkleMap root of approval counts (`proposalHash → count`) |
| 6 | `configNonce` | Incremented on governance changes; invalidates stale proposals |
| 7 | `networkId` | Network identifier; prevents cross-network replay |

## Owner Storage Model

Owners are stored as an **ordered list** off-chain. On-chain, a single commitment field represents the entire list via a chain hash:

```
chain = Poseidon.hashWithPrefix('owner-chain', [])   // INITIAL_OWNER_CHAIN
for each owner in list:
  chain = Poseidon.hash([chain, owner.x, owner.isOdd.toField()])
```

This design means the full owner list is the witness, not a Merkle path. The witness type is a fixed-size array:

```typescript
class OwnerWitness extends Struct({
  owners: Provable.Array(Option(PublicKey), MAX_OWNERS)  // MAX_OWNERS = 20
})
```

Active owners are `Some(pk)`, padding slots are `None`. Three circuit functions in `list-commitment.ts` operate on this structure:

- **`assertOwnerMembership`** — Iterates the witness, recomputes the chain hash, checks that the claimed owner appears, and asserts the final chain equals `ownersCommitment`.
- **`addOwnerToCommitment`** — Inserts a new owner into the chain. Accepts an `insertAfter: Option(PublicKey)` parameter: `None` prepends, `Some(pk)` inserts after that key. Returns `[newChain, valid]`. Caller must check `valid` and enforce size bounds.
- **`removeOwnerFromCommitment`** — Rebuilds the chain while skipping the target owner. Returns `[newChain, valid]`. Caller must check `valid` and enforce `numOwners >= threshold`.

## Off-Chain Storage

Three independent store classes in `storage.ts` mirror on-chain roots. Each is self-contained and serializable.

### OwnerStore

An ordered `PublicKey[]` array. Methods: `add()`, `remove()`, `insertAfter()`, `isOwner()`, `getCommitment()` (computes chain hash), `getWitness()` (returns `OwnerWitness` padded to `MAX_OWNERS`). Serializes via JSON with base58-encoded keys.

### ApprovalStore

A `MerkleMap` keyed by `proposalHash`. The value encodes proposal state with a marker offset:

| Value | Meaning |
| ----- | ------- |
| `Field(0)` | Not proposed (MerkleMap default) |
| `PROPOSED_MARKER` (1) | Proposed, 0 approvals |
| `PROPOSED_MARKER + N` | Proposed, N approvals |
| `EXECUTED_MARKER` (max field value) | Executed |

This encoding distinguishes "never proposed" from "proposed with 0 approvals", preventing approval of fabricated proposals.

Methods: `getCount()`, `setCount()`, `getWitness()`, `isExecuted()`, `getRoot()`.

### VoteNullifierStore

A `MerkleMap` keyed by `Poseidon.hash([proposalHash, ...approver.toFields()])`. Value is `Field(0)` (not voted) or `Field(1)` (voted). Prevents the same owner from approving the same proposal twice.

Methods: `isNullified()`, `nullify()`, `getWitness()`, `getRoot()`.

## Proposal Structure

```typescript
class Receiver extends Struct({
  address: PublicKey,
  amount:  UInt64,
})

class TransactionProposal extends Struct({
  receivers:    Provable.Array(Receiver, MAX_RECEIVERS),  // Fixed-size array of recipients
  tokenId:      Field,       // Token ID (Field(0) for MINA)
  txType:       Field,       // TxType value
  data:         Field,       // Context-dependent payload (see below)
  uid:          Field,       // Unique ID from proposalCounter
  configNonce:  Field,       // Must match on-chain configNonce
  expiryBlock:  Field,       // Block height deadline (0 = no expiry)
  networkId:    Field,       // Must match on-chain networkId
  guardAddress: PublicKey,   // Must match contract address
})
```

Unused receiver slots use `Receiver.empty()` (`PublicKey.empty()` + `UInt64(0)`). Non-transfer proposals (governance actions) use all-empty receiver slots.

`hash()` returns `Poseidon(all fields)`. This hash is the universal key for approval counts, vote nullifiers, and signatures.

### Why hash-keyed instead of nonce-keyed

A sequential nonce would allow **proposal substitution**: an attacker could craft a different proposal with the same nonce and collect approvals for an unintended transaction. Keying by content hash ensures approvals are cryptographically bound to the exact proposal fields.

### TxType enum and `data` field usage

| TxType | Value | `data` contains |
| ------ | ----- | --------------- |
| `TRANSFER` | 0 | `Field(0)` (receiver data is in the `receivers`/`amounts` arrays instead) |
| `ADD_OWNER` | 1 | `ownerKey(newOwner)` — Poseidon hash of the owner to add |
| `REMOVE_OWNER` | 2 | `ownerKey(owner)` — Poseidon hash of the owner to remove |
| `CHANGE_THRESHOLD` | 3 | New threshold value as a Field |
| `SET_DELEGATE` | 4 | `ownerKey(delegate)` for delegation, `Field(0)` for un-delegation |

## Constants

Defined in `constants.ts`:

| Constant | Value | Purpose |
| -------- | ----- | ------- |
| `MAX_RECEIVERS` | `5` | Fixed-size bound for receiver/amount arrays in proposals |
| `MAX_OWNERS` | `20` | Fixed-size bound for owner witnesses and signature batches |
| `INITIAL_OWNER_CHAIN` | `Poseidon.hashWithPrefix('owner-chain', [])` | Chain hash seed for owners |
| `INITIAL_SIGNER_CHAIN` | `Poseidon.hashWithPrefix('signer-chain', [])` | Chain hash seed for batch signer audit trail |
| `PROPOSED_MARKER` | `Field(1)` | Base value written to approval map on propose |
| `EXECUTED_MARKER` | `Field(0).sub(1)` | Max field value; marks executed proposals |
| `EMPTY_MERKLE_MAP_ROOT` | `new MerkleMap().getRoot()` | Initializes `approvalRoot` and `voteNullifierRoot` |

## On-Chain Multi-Step Flow

### Deploy

`deploy()` sets account permissions (see Permissions section) and emits a `DeployEvent` with the contract address for indexer discovery.

### Setup

`setup(ownersCommitment, threshold, numOwners, networkId, initialOwners)` — one-time initialization.

- Guard: `ownersCommitment == Field(0)` (not yet initialized)
- Validates: `threshold > 0`, `numOwners >= threshold`, `numOwners <= MAX_OWNERS`
- Initializes all 8 state fields; `approvalRoot` and `voteNullifierRoot` set to `EMPTY_MERKLE_MAP_ROOT`
- Emits `SetupEvent` + one `SetupOwnerEvent` per `MAX_OWNERS` slot (fixed-size for deterministic indexing)
- Trust model: clients should independently compute the expected commitment and verify it matches

### Propose (with auto-approve)

`propose(proposal, ownerWitness, proposer, signature, voteNullifierWitness, approvalWitness)`

There is only one propose method and it **always auto-approves** as the proposer's first vote:

1. Verify proposer is an owner (chain hash witness)
2. Assert `configNonce`, `networkId`, `guardAddress` match on-chain values
3. Increment `proposalCounter`
4. Verify proposer's signature over `[proposalHash]`
5. Check and set vote nullifier (prevents re-proposal)
6. Assert approval slot is empty (`Field(0)`), then write `PROPOSED_MARKER + 1` (= `Field(2)`, the marker plus the proposer's approval)
7. Emit `ProposalEvent` (includes all proposal fields for indexer reconstruction) and `ApprovalEvent`

### Approve

`approveProposal(proposal, signature, approver, ownerWitness, approvalWitness, currentApprovalCount, voteNullifierWitness)`

1. Verify approver is an owner
2. Assert `configNonce`, `networkId`, `guardAddress` match
3. Verify signature over `[proposalHash]`
4. Assert proposal exists (`count >= PROPOSED_MARKER`) and not executed (`count != EXECUTED_MARKER`)
5. Check and set vote nullifier (prevents double-vote)
6. Increment approval count in the approval map
7. Emit `ApprovalEvent`

### Execute (4 methods)

All execute methods share these common checks:

- Wallet is initialized (`ownersCommitment != 0`)
- `txType` matches the method
- `configNonce`, `networkId`, `guardAddress` match on-chain values
- Proposal not expired (if `expiryBlock != 0`, asserts `blockchainLength <= expiryBlock`)
- Not already executed (`approvalCount != EXECUTED_MARKER`)
- Proposal exists (`approvalCount >= PROPOSED_MARKER`)
- Threshold satisfied: `approvalCount - PROPOSED_MARKER >= threshold`
- Approval witness verified against `approvalRoot`

After execution, the approval count is overwritten with `EXECUTED_MARKER`, permanently preventing re-execution or further approvals. Execution is **permissionless** — anyone can trigger it once the threshold is met.

**`executeTransfer`** — Loops through all `MAX_RECEIVERS` slots, sending to each non-empty receiver. Empty slots (`PublicKey.empty()`) get their amount zeroed via `Provable.if` (a send of 0 is a no-op). Emits `ExecutionEvent`.

**`executeOwnerChange`** — Handles both `ADD_OWNER` and `REMOVE_OWNER` via boolean flags. Verifies `proposal.data == ownerKey(ownerPubKey)`. Runs both `addOwnerToCommitment` and `removeOwnerFromCommitment` circuits, then selects the correct result based on `txType`. Asserts `newNumOwners >= threshold` and `<= MAX_OWNERS`. Updates `ownersCommitment` and `numOwners`. Increments `configNonce`. Emits `ExecutionEvent` + `OwnerChangeEvent`.

**`executeThresholdChange`** — Validates `proposal.data == newThreshold`, `newThreshold > 0`, `numOwners >= newThreshold`. Updates `threshold`. Increments `configNonce`. Emits `ExecutionEvent` + `ThresholdChangeEvent`.

**`executeDelegate`** — Validates `proposal.data` is `Field(0)` (un-delegate to self) or `ownerKey(delegate)`. Sets `account.delegate` accordingly. Does **not** increment `configNonce`. Emits `ExecutionEvent` + `DelegateEvent`.

## Batch Signature Flow

The batch flow bypasses the multi-step propose/approve/execute cycle. Signatures from a quorum of owners are collected **off-chain** and verified in a single transaction.

Four batch methods: `executeTransferBatchSig`, `executeOwnerChangeBatchSig`, `executeThresholdChangeBatchSig`, `executeDelegateBatchSig`. `executeTransferBatchSig` loops through all `MAX_RECEIVERS` slots, sending to each non-empty receiver (empty slots get their amount zeroed via `Provable.if`, so a send of 0 is a no-op), mirroring `executeTransfer`.

### Batch Verification Circuit

`batchVerify()` in `batch-verify.ts` takes a `SignatureInputs` struct — a fixed-size array of `MAX_OWNERS` optional `(Option(Signature), PublicKey)` pairs. Three cases per slot:

| Slot state | Meaning |
| ---------- | ------- |
| `None` (outer) | Empty owner slot (padding) |
| `Some` with `signature: None` | Owner exists but did not sign |
| `Some` with `signature: Some(sig)` | Owner exists and provided signature |

The circuit iterates all slots and computes:

- **`ownerChain`** — Hashes all `isSome` public keys into a chain hash. The caller asserts this equals `ownersCommitment`, proving the witness represents the real owner list.
- **`signerChain`** — Hashes only public keys with valid signatures. Emitted in events as an auditable trail of who signed.
- **`approvalCount`** — Number of valid signatures verified.

Returns `{ approvalCount, signerChain, ownerChain }`.

### Differences from On-Chain Flow

- **No pre-registration**: The approval slot must be `Field(0)` (never proposed), not `>= PROPOSED_MARKER`. The proposal is registered and executed atomically.
- **Direct threshold check**: `approvalCount >= threshold` (no `PROPOSED_MARKER` offset).
- **Counter incremented**: `proposalCounter` advances, ensuring unique UIDs across both flows.
- **Batch-specific events**: Each method emits its own batch event type (e.g., `ExecutionBatchEvent`) that includes `approverChain` for on-chain audit. The standard flow events (`ExecutionEvent`, etc.) are not emitted.

## Events

### Standard Flow Events

| Event | Fields | Emitted By |
| ----- | ------ | ---------- |
| `DeployEvent` | `guardAddress` | `deploy` |
| `SetupEvent` | `ownersCommitment, threshold, numOwners, networkId` | `setup` |
| `SetupOwnerEvent` | `owner, index` | `setup` (one per `MAX_OWNERS` slot) |
| `ProposalEvent` | `proposalHash, proposer, tokenId, txType, data, uid, configNonce, expiryBlock, networkId, guardAddress` | `propose` (receiver data emitted via separate `ProposalReceiverEvent`s) |
| `ProposalReceiverEvent` | `proposalHash, receiver, amount, index` | `propose` (one per `MAX_RECEIVERS` slot) |
| `ApprovalEvent` | `proposalHash, approver, approvalCount` | `propose`, `approveProposal` |
| `ExecutionEvent` | `proposalHash, txType` | `executeTransfer`, `executeOwnerChange`, `executeThresholdChange`, `executeDelegate` (receivers committed via `proposalHash`) |
| `OwnerChangeEvent` | `proposalHash, owner, added, newNumOwners` | `executeOwnerChange` |
| `ThresholdChangeEvent` | `proposalHash, oldThreshold, newThreshold` | `executeThresholdChange` |
| `DelegateEvent` | `proposalHash, delegate` | `executeDelegate` |

### Batch Flow Events

| Event | Fields | Emitted By |
| ----- | ------ | ---------- |
| `ExecutionBatchEvent` | `proposalHash, txType, approverChain` | `executeTransferBatchSig` |
| `OwnerChangeBatchEvent` | `proposalHash, owner, added, newNumOwners, approverChain` | `executeOwnerChangeBatchSig` |
| `ThresholdChangeBatchEvent` | `proposalHash, oldThreshold, newThreshold, approverChain` | `executeThresholdChangeBatchSig` |
| `DelegateBatchEvent` | `proposalHash, delegate, approverChain` | `executeDelegateBatchSig` |

`ProposalEvent` includes all scalar proposal fields so an indexer can reconstruct proposal details purely from on-chain events. Receiver arrays are emitted as per-slot `ProposalReceiverEvent`s rather than inline arrays because Mina limits events to 16 field elements.

## Security Properties

| Property | Mechanism |
| -------- | --------- |
| Only owners can propose | Chain hash witness verified against `ownersCommitment` |
| Only owners can approve | Chain hash witness + signature over `proposalHash` |
| No double-voting | Vote nullifier map keyed by `hash(proposalHash, approver)` |
| Proposal existence verified | `PROPOSED_MARKER` in approval map (on-chain flow) |
| No re-execution | `EXECUTED_MARKER` replaces count after execution (both flows) |
| Stale proposals rejected | `configNonce` in proposal must match on-chain value |
| Time-bounded proposals | Optional `expiryBlock` checked against `blockchainLength` |
| No proposal substitution | Approvals keyed by content hash, not sequential ID |
| Cross-network replay prevented | `networkId` in proposal must match on-chain |
| Cross-contract replay prevented | `guardAddress` in proposal must match `this.address` |
| Vault cannot be locked | Remove-owner asserts `newNumOwners >= threshold` |
| Anyone can execute | Execution is permissionless once threshold is met |
| MINA receivable | `receive: Permissions.none()` allows deposits without proof |
| State changes proof-only | `editState: Permissions.proof()` — no signature fallback |
| Permission downgrade prevented | `setPermissions: Permissions.proof()` |
| Bounded circuit size | `MAX_OWNERS = 20` caps witness and batch arrays |
| Batch signer verification | `ownerChain` from `batchVerify` must equal `ownersCommitment` |

## Permissions

Set in `deploy()`:

| Permission | Value | Rationale |
| ---------- | ----- | --------- |
| `editState` | `proof()` | State changes only via proven contract methods |
| `send` | `proof()` | Outgoing transfers only via proven contract methods |
| `receive` | `none()` | Anyone can deposit MINA without a proof |
| `setDelegate` | `proof()` | Delegation only via proven contract methods |
| `setPermissions` | `proof()` | Prevents permission downgrade attacks |

All other permissions use `Permissions.default()`.
