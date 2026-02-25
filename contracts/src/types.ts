import {
  Field,
  PublicKey,
  UInt64,
  Struct,
  Poseidon,
  MerkleMapWitness,
  Signature,
} from 'o1js';

// ── Transaction Types ────────────────────────────────────────────────
export const TxType = {
  TRANSFER: Field(0),
  ADD_OWNER: Field(1),
  REMOVE_OWNER: Field(2),
  CHANGE_THRESHOLD: Field(3),
  REGISTER_GUARD: Field(4),
};

// ── Transaction Proposal ─────────────────────────────────────────────
export class TransactionProposal extends Struct({
  to: PublicKey,
  amount: UInt64,
  tokenId: Field,
  txType: Field,
  data: Field, // Poseidon hash of extra data (new owner key, new threshold, etc.)
  nonce: Field,
}) {
  hash(): Field {
    return Poseidon.hash([
      ...this.to.toFields(),
      ...this.amount.toFields(),
      this.tokenId,
      this.txType,
      this.data,
      this.nonce,
    ]);
  }
}

// ── Owner Witness (proves membership in owner MerkleMap) ─────────────
export class OwnerWitness extends Struct({
  witness: MerkleMapWitness,
}) {}

// ── Approval Witness (proves approval count in approval MerkleMap) ───
export class ApprovalWitness extends Struct({
  witness: MerkleMapWitness,
}) {}

// ── Pending Tx Witness (proves tx existence in pending MerkleMap) ────
export class PendingTxWitness extends Struct({
  witness: MerkleMapWitness,
}) {}

// ── Guard Witness (proves guard registration in guard MerkleMap) ─────
export class GuardWitness extends Struct({
  witness: MerkleMapWitness,
}) {}

// ── Signature with owner key (used for approve) ─────────────────────
export class SignedApproval extends Struct({
  signature: Signature,
  owner: PublicKey,
}) {}

// ── Helper: compute the MerkleMap key for an owner ──────────────────
export function ownerKey(owner: PublicKey): Field {
  return Poseidon.hash(owner.toFields());
}

// ── Events ──────────────────────────────────────────────────────────
export class ProposalEvent extends Struct({
  txId: Field,
  proposer: PublicKey,
  txHash: Field,
  nonce: Field,
}) {}

export class ApprovalEvent extends Struct({
  txId: Field,
  approver: PublicKey,
  approvalCount: Field,
}) {}

export class ExecutionEvent extends Struct({
  txId: Field,
  to: PublicKey,
  amount: UInt64,
  txType: Field,
}) {}

export class OwnerChangeEvent extends Struct({
  owner: PublicKey,
  added: Field, // Field(1) = added, Field(0) = removed
  newNumOwners: Field,
}) {}

export class ThresholdChangeEvent extends Struct({
  oldThreshold: Field,
  newThreshold: Field,
}) {}
