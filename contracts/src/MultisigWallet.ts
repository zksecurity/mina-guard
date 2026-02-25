import {
  SmartContract,
  state,
  State,
  method,
  Field,
  PublicKey,
  UInt64,
  Permissions,
  MerkleMapWitness,
  Poseidon,
  Signature,
} from 'o1js';

import {
  TransactionProposal,
  TxType,
  ownerKey,
  ProposalEvent,
  ApprovalEvent,
  ExecutionEvent,
  OwnerChangeEvent,
  ThresholdChangeEvent,
} from './types.js';

export class MultisigWallet extends SmartContract {
  // ── On-chain State (8 Fields) ────────────────────────────────────
  @state(Field) ownersRoot = State<Field>();
  @state(Field) threshold = State<Field>();
  @state(Field) numOwners = State<Field>();
  @state(Field) txNonce = State<Field>();
  @state(Field) voteNullifierRoot = State<Field>();
  @state(Field) approvalRoot = State<Field>();
  @state(Field) guardRoot = State<Field>();
  @state(Field) configNonce = State<Field>();

  // ── Events ───────────────────────────────────────────────────────
  events = {
    proposal: ProposalEvent,
    approval: ApprovalEvent,
    execution: ExecutionEvent,
    ownerChange: OwnerChangeEvent,
    thresholdChange: ThresholdChangeEvent,
  };

  // ── Deploy ───────────────────────────────────────────────────────
  async deploy() {
    await super.deploy();
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proofOrSignature(),
      send: Permissions.proofOrSignature(),
      receive: Permissions.none(),
    });
  }

  // super.init() already initializes all @state fields to Field(0)

  // ── Setup: one-time initialization with owners and threshold ────
  @method async setup(
    ownersRoot: Field,
    threshold: Field,
    numOwners: Field,
    emptyMapRoot: Field
  ) {
    // Can only setup once (ownersRoot must be 0)
    const currentRoot = this.ownersRoot.getAndRequireEquals();
    currentRoot.assertEquals(Field(0), 'Already initialized');

    // Validate threshold
    threshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      threshold,
      'Owners must be >= threshold'
    );

    this.ownersRoot.set(ownersRoot);
    this.threshold.set(threshold);
    this.numOwners.set(numOwners);
    // Initialize Merkle roots to empty MerkleMap root
    this.approvalRoot.set(emptyMapRoot);
    this.voteNullifierRoot.set(emptyMapRoot);
    this.guardRoot.set(emptyMapRoot);
  }

  // ── Propose: owner proposes a new transaction ───────────────────
  @method async propose(
    proposal: TransactionProposal,
    ownerWitness: MerkleMapWitness,
    proposer: PublicKey
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify proposer is an owner
    const key = ownerKey(proposer);
    const [computedRoot, computedKey] = ownerWitness.computeRootAndKey(
      Field(1)
    );
    computedRoot.assertEquals(ownersRoot, 'Not an owner');
    computedKey.assertEquals(key, 'Owner key mismatch');

    // Verify nonce matches
    const currentNonce = this.txNonce.getAndRequireEquals();
    proposal.nonce.assertEquals(currentNonce, 'Nonce mismatch');

    // Compute tx hash and store in pending
    const txHash = proposal.hash();

    // We need a witness for the pending tx map at the nonce key
    // The caller must provide a valid witness for the empty slot

    // Increment nonce
    this.txNonce.set(currentNonce.add(1));

    // Emit proposal event
    this.emitEvent('proposal', {
      txId: proposal.nonce,
      proposer,
      txHash,
      nonce: proposal.nonce,
    });
  }

  // ── Approve: owner approves a pending transaction ───────────────
  @method async approveTx(
    txId: Field,
    txHash: Field,
    signature: Signature,
    approver: PublicKey,
    ownerWitness: MerkleMapWitness,
    approvalWitness: MerkleMapWitness,
    currentApprovalCount: Field,
    voteNullifierWitness: MerkleMapWitness
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify approver is an owner
    const key = ownerKey(approver);
    const [computedOwnerRoot, computedOwnerKey] =
      ownerWitness.computeRootAndKey(Field(1));
    computedOwnerRoot.assertEquals(ownersRoot, 'Not an owner');
    computedOwnerKey.assertEquals(key, 'Owner key mismatch');

    // Verify signature on the txHash
    signature.verify(approver, [txHash]).assertTrue('Invalid signature');

    // Prevent double approval: verify this owner has NOT voted on this tx yet
    const voteNullifierKey = Poseidon.hash([txId, ...approver.toFields()]);
    const voteNullifierRoot = this.voteNullifierRoot.getAndRequireEquals();
    const [computedVoteRoot, computedVoteKey] =
      voteNullifierWitness.computeRootAndKey(Field(0));
    computedVoteRoot.assertEquals(voteNullifierRoot, 'Vote nullifier root mismatch');
    computedVoteKey.assertEquals(voteNullifierKey, 'Vote nullifier key mismatch');

    // Record the vote nullifier (set value to 1)
    const [newVoteRoot] = voteNullifierWitness.computeRootAndKey(Field(1));
    this.voteNullifierRoot.set(newVoteRoot);

    // Verify current approval count via witness
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(currentApprovalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(txId, 'Approval key mismatch');

    // Increment approval count
    const newApprovalCount = currentApprovalCount.add(1);
    const [newApprovalRoot] =
      approvalWitness.computeRootAndKey(newApprovalCount);
    this.approvalRoot.set(newApprovalRoot);

    // Emit approval event
    this.emitEvent('approval', {
      txId,
      approver,
      approvalCount: newApprovalCount,
    });
  }

  // ── Execute: execute a transaction once threshold is met ────────
  @method async execute(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify threshold is met
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval count in the MerkleMap
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const txId = proposal.nonce;
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(txId, 'Approval key mismatch');

    // Verify tx type is transfer
    proposal.txType.assertEquals(TxType.TRANSFER, 'Not a transfer tx');

    // Execute the MINA transfer
    this.send({ to: proposal.to, amount: proposal.amount });

    // Clear approval (set to a sentinel value to mark as executed)
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(
      Field(0).sub(1) // Max field as "executed" marker
    );
    this.approvalRoot.set(newApprovalRoot);

    // Emit execution event
    this.emitEvent('execution', {
      txId,
      to: proposal.to,
      amount: proposal.amount,
      txType: proposal.txType,
    });
  }

  // ── Add Owner: requires multisig approval ──────────────────────
  @method async addOwner(
    proposal: TransactionProposal,
    newOwner: PublicKey,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    newOwnerWitness: MerkleMapWitness
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify threshold is met
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval count
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const txId = proposal.nonce;
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(txId, 'Approval key mismatch');

    // Verify tx type
    proposal.txType.assertEquals(TxType.ADD_OWNER, 'Not an addOwner tx');

    // Verify data matches new owner hash
    const newOwnerHash = Poseidon.hash(newOwner.toFields());
    proposal.data.assertEquals(
      newOwnerHash,
      'Proposal data does not match new owner'
    );

    // Verify new owner is NOT already in the map (value should be 0)
    const newOwnerMerkleKey = ownerKey(newOwner);
    const [currentOwnerRoot, computedNewOwnerKey] =
      newOwnerWitness.computeRootAndKey(Field(0));
    currentOwnerRoot.assertEquals(ownersRoot, 'Owner root mismatch');
    computedNewOwnerKey.assertEquals(
      newOwnerMerkleKey,
      'New owner key mismatch'
    );

    // Add new owner (set value to 1)
    const [newOwnersRoot] = newOwnerWitness.computeRootAndKey(Field(1));
    this.ownersRoot.set(newOwnersRoot);

    // Increment owner count
    const numOwners = this.numOwners.getAndRequireEquals();
    this.numOwners.set(numOwners.add(1));

    // Mark proposal as executed in approval map
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(
      Field(0).sub(1)
    );
    this.approvalRoot.set(newApprovalRoot);

    // Increment config nonce
    const configNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(configNonce.add(1));

    // Emit events
    this.emitEvent('ownerChange', {
      owner: newOwner,
      added: Field(1),
      newNumOwners: numOwners.add(1),
    });
  }

  // ── Remove Owner: requires multisig approval ──────────────────
  @method async removeOwner(
    proposal: TransactionProposal,
    ownerToRemove: PublicKey,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    ownerToRemoveWitness: MerkleMapWitness
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify threshold is met
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval count
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const txId = proposal.nonce;
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(txId, 'Approval key mismatch');

    // Verify tx type
    proposal.txType.assertEquals(
      TxType.REMOVE_OWNER,
      'Not a removeOwner tx'
    );

    // Verify data matches owner to remove
    const removeOwnerHash = Poseidon.hash(ownerToRemove.toFields());
    proposal.data.assertEquals(
      removeOwnerHash,
      'Proposal data does not match owner to remove'
    );

    // Verify owner IS in the map (value should be 1)
    const removeOwnerMerkleKey = ownerKey(ownerToRemove);
    const [currentOwnerRoot, computedRemoveKey] =
      ownerToRemoveWitness.computeRootAndKey(Field(1));
    currentOwnerRoot.assertEquals(ownersRoot, 'Owner root mismatch');
    computedRemoveKey.assertEquals(
      removeOwnerMerkleKey,
      'Owner key mismatch'
    );

    // Ensure numOwners - 1 >= threshold
    const numOwners = this.numOwners.getAndRequireEquals();
    numOwners.sub(1).assertGreaterThanOrEqual(
      threshold,
      'Cannot remove: would go below threshold'
    );

    // Remove owner (set value to 0)
    const [newOwnersRoot] = ownerToRemoveWitness.computeRootAndKey(
      Field(0)
    );
    this.ownersRoot.set(newOwnersRoot);

    // Decrement owner count
    this.numOwners.set(numOwners.sub(1));

    // Mark proposal as executed
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(
      Field(0).sub(1)
    );
    this.approvalRoot.set(newApprovalRoot);

    // Increment config nonce
    const configNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(configNonce.add(1));

    // Emit events
    this.emitEvent('ownerChange', {
      owner: ownerToRemove,
      added: Field(0),
      newNumOwners: numOwners.sub(1),
    });
  }

  // ── Change Threshold: requires multisig approval ──────────────
  @method async changeThreshold(
    proposal: TransactionProposal,
    newThreshold: Field,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify threshold is met (using current threshold)
    const currentThreshold = this.threshold.getAndRequireEquals();
    approvalCount.assertGreaterThanOrEqual(
      currentThreshold,
      'Insufficient approvals'
    );

    // Verify approval count
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const txId = proposal.nonce;
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(txId, 'Approval key mismatch');

    // Verify tx type
    proposal.txType.assertEquals(
      TxType.CHANGE_THRESHOLD,
      'Not a changeThreshold tx'
    );

    // Verify data matches new threshold
    proposal.data.assertEquals(
      newThreshold,
      'Proposal data does not match new threshold'
    );

    // Validate new threshold
    const numOwners = this.numOwners.getAndRequireEquals();
    newThreshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      newThreshold,
      'Threshold cannot exceed owner count'
    );

    // Update threshold
    const oldThreshold = currentThreshold;
    this.threshold.set(newThreshold);

    // Mark proposal as executed
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(
      Field(0).sub(1)
    );
    this.approvalRoot.set(newApprovalRoot);

    // Increment config nonce
    const configNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(configNonce.add(1));

    // Emit event
    this.emitEvent('thresholdChange', {
      oldThreshold,
      newThreshold,
    });
  }

  // ── Register Guard/Module: requires multisig approval ──────────
  @method async registerGuard(
    proposal: TransactionProposal,
    guardHash: Field,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    guardWitness: MerkleMapWitness
  ) {
    // Verify wallet is initialized
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Verify threshold is met
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval count
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const txId = proposal.nonce;
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(txId, 'Approval key mismatch');

    // Verify tx type
    proposal.txType.assertEquals(
      TxType.REGISTER_GUARD,
      'Not a registerGuard tx'
    );

    // Verify data matches guard hash
    proposal.data.assertEquals(
      guardHash,
      'Proposal data does not match guard hash'
    );

    // Verify guard is not already registered (value = 0)
    const guardRoot = this.guardRoot.getAndRequireEquals();
    const [computedGuardRoot, computedGuardKey] =
      guardWitness.computeRootAndKey(Field(0));
    computedGuardRoot.assertEquals(guardRoot, 'Guard root mismatch');
    computedGuardKey.assertEquals(guardHash, 'Guard key mismatch');

    // Register guard (set value to 1)
    const [newGuardRoot] = guardWitness.computeRootAndKey(Field(1));
    this.guardRoot.set(newGuardRoot);

    // Mark proposal as executed
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(
      Field(0).sub(1)
    );
    this.approvalRoot.set(newApprovalRoot);

    // Increment config nonce
    const configNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(configNonce.add(1));
  }
}
