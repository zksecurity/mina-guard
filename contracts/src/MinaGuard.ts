import {
  SmartContract,
  state,
  State,
  method,
  Field,
  PublicKey,
  Permissions,
  MerkleMap,
  MerkleMapWitness,
  Poseidon,
  Provable,
  Signature,
  Struct,
  UInt64,
} from 'o1js';

// -- Constants ---------------------------------------------------------------

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

// -- Helper ------------------------------------------------------------------

export function ownerKey(owner: PublicKey): Field {
  return Poseidon.hash(owner.toFields());
}

// -- Types -------------------------------------------------------------------

export class TransactionProposal extends Struct({
  to: PublicKey,
  amount: UInt64,
  tokenId: Field,
  txType: Field,
  data: Field,
  nonce: Field,
  configNonce: Field,
  expiryBlock: Field,
  networkId: Field,
}) {
  hash(): Field {
    return Poseidon.hash([
      ...this.to.toFields(),
      ...this.amount.toFields(),
      this.tokenId,
      this.txType,
      this.data,
      this.nonce,
      this.configNonce,
      this.expiryBlock,
      this.networkId,
    ]);
  }
}

// -- Witness Wrappers --------------------------------------------------------

export class OwnerWitness extends Struct({
  witness: MerkleMapWitness,
}) { }

export class ApprovalWitness extends Struct({
  witness: MerkleMapWitness,
}) { }

export class VoteNullifierWitness extends Struct({
  witness: MerkleMapWitness,
}) { }

// -- Events ------------------------------------------------------------------

export class ProposalEvent extends Struct({
  proposalHash: Field,
  proposer: PublicKey,
  nonce: Field,
}) { }

export class ApprovalEvent extends Struct({
  proposalHash: Field,
  approver: PublicKey,
  approvalCount: Field,
}) { }

export class ExecutionEvent extends Struct({
  proposalHash: Field,
  to: PublicKey,
  amount: UInt64,
  txType: Field,
}) { }

export class OwnerChangeEvent extends Struct({
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
}) { }

export class ThresholdChangeEvent extends Struct({
  oldThreshold: Field,
  newThreshold: Field,
}) { }

export class DelegateEvent extends Struct({
  delegate: PublicKey,
}) { }

// -- Contract ----------------------------------------------------------------

export class MinaGuard extends SmartContract {
  @state(Field) ownersRoot = State<Field>();
  @state(Field) threshold = State<Field>();
  @state(Field) numOwners = State<Field>();
  @state(Field) proposalNonce = State<Field>();
  @state(Field) voteNullifierRoot = State<Field>();
  @state(Field) approvalRoot = State<Field>();
  @state(Field) configNonce = State<Field>();
  @state(Field) networkId = State<Field>();

  events = {
    proposal: ProposalEvent,
    approval: ApprovalEvent,
    execution: ExecutionEvent,
    ownerChange: OwnerChangeEvent,
    thresholdChange: ThresholdChangeEvent,
    delegate: DelegateEvent,
  };

  async deploy() {
    await super.deploy();
    // TODO: review permissions
    this.account.permissions.set({
      // ...Permissions.allImpossible(),
      ...Permissions.default(),
      editState: Permissions.proof(),
      send: Permissions.proof(),
      receive: Permissions.none(),
      setDelegate: Permissions.proof(),
      setPermissions: Permissions.proof(),
    });
  }

  // TODO: verify if we need an additional check here, to avoid front-running
  @method async setup(
    ownersRoot: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field
  ) {
    const currentRoot = this.ownersRoot.getAndRequireEquals();
    currentRoot.assertEquals(Field(0), 'Already initialized');

    threshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      threshold,
      'Owners must be >= threshold'
    );

    this.ownersRoot.set(ownersRoot);
    this.threshold.set(threshold);
    this.numOwners.set(numOwners);
    this.approvalRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.voteNullifierRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.networkId.set(networkId);
  }

  @method async propose(
    proposal: TransactionProposal,
    ownerWitness: MerkleMapWitness,
    proposer: PublicKey,
    approvalWitness: MerkleMapWitness
  ) {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    const key = ownerKey(proposer);
    const [computedRoot, computedKey] = ownerWitness.computeRootAndKey(Field(1));
    computedRoot.assertEquals(ownersRoot, 'Not an owner');
    computedKey.assertEquals(key, 'Owner key mismatch');

    const currentNonce = this.proposalNonce.getAndRequireEquals();
    proposal.nonce.assertEquals(currentNonce, 'Nonce mismatch');

    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(
      currentConfigNonce,
      'Config nonce mismatch'
    );

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    const proposalHash = proposal.hash();

    this.proposalNonce.set(currentNonce.add(1));

    // Register proposal in the approval map (slot must be empty)
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(Field(0));
    computedApprovalRoot.assertEquals(approvalRoot, 'Approval root mismatch');
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    const [newApprovalRoot] = approvalWitness.computeRootAndKey(PROPOSED_MARKER);
    this.approvalRoot.set(newApprovalRoot);

    this.emitEvent('proposal', {
      proposalHash,
      proposer,
      nonce: proposal.nonce,
    });
  }

  @method async proposeAndApprove(
    proposal: TransactionProposal,
    ownerWitness: MerkleMapWitness,
    proposer: PublicKey,
    signature: Signature,
    voteNullifierWitness: MerkleMapWitness,
    approvalWitness: MerkleMapWitness
  ) {
    // --- propose logic ---
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    const key = ownerKey(proposer);
    const [computedRoot, computedKey] = ownerWitness.computeRootAndKey(
      Field(1)
    );
    computedRoot.assertEquals(ownersRoot, 'Not an owner');
    computedKey.assertEquals(key, 'Owner key mismatch');

    const currentNonce = this.proposalNonce.getAndRequireEquals();
    proposal.nonce.assertEquals(currentNonce, 'Nonce mismatch');

    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(
      currentConfigNonce,
      'Config nonce mismatch'
    );

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    const proposalHash = proposal.hash();

    this.proposalNonce.set(currentNonce.add(1));

    // --- approval logic ---
    signature.verify(proposer, [proposalHash]).assertTrue('Invalid signature');

    // Vote nullifier
    const voteNullifierKey = Poseidon.hash([proposalHash, ...proposer.toFields()]);
    const voteNullifierRoot = this.voteNullifierRoot.getAndRequireEquals();
    const [computedVoteRoot, computedVoteKey] =
      voteNullifierWitness.computeRootAndKey(Field(0));
    computedVoteRoot.assertEquals(
      voteNullifierRoot,
      'Vote nullifier root mismatch'
    );
    computedVoteKey.assertEquals(
      voteNullifierKey,
      'Vote nullifier key mismatch'
    );

    const [newVoteRoot] = voteNullifierWitness.computeRootAndKey(Field(1));
    this.voteNullifierRoot.set(newVoteRoot);

    // Approval count: must start at 0 for a new proposal
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(Field(0));
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    // PROPOSED_MARKER (1) + 1 approval = 2
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(PROPOSED_MARKER.add(1));
    this.approvalRoot.set(newApprovalRoot);

    this.emitEvent('proposal', {
      proposalHash,
      proposer,
      nonce: proposal.nonce,
    });

    this.emitEvent('approval', {
      proposalHash,
      approver: proposer,
      approvalCount: Field(1),
    });
  }

  @method async approveProposal(
    proposal: TransactionProposal,
    signature: Signature,
    approver: PublicKey,
    ownerWitness: MerkleMapWitness,
    approvalWitness: MerkleMapWitness,
    currentApprovalCount: Field,
    voteNullifierWitness: MerkleMapWitness
  ) {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    const key = ownerKey(approver);
    const [computedOwnerRoot, computedOwnerKey] =
      ownerWitness.computeRootAndKey(Field(1));
    computedOwnerRoot.assertEquals(ownersRoot, 'Not an owner');
    computedOwnerKey.assertEquals(key, 'Owner key mismatch');

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    const proposalHash = proposal.hash();
    signature.verify(approver, [proposalHash]).assertTrue('Invalid signature');

    // Ensure the proposal was actually proposed (marker >= 1) and not already executed
    currentApprovalCount
      .equals(EXECUTED_MARKER)
      .assertFalse('Proposal already executed');
    currentApprovalCount.assertGreaterThanOrEqual(
      PROPOSED_MARKER,
      'Proposal not found'
    );

    // Vote nullifier: keyed by hash(proposalHash, approver)
    const voteNullifierKey = Poseidon.hash([proposalHash, ...approver.toFields()]);
    const voteNullifierRoot = this.voteNullifierRoot.getAndRequireEquals();
    const [computedVoteRoot, computedVoteKey] =
      voteNullifierWitness.computeRootAndKey(Field(0));
    computedVoteRoot.assertEquals(
      voteNullifierRoot,
      'Vote nullifier root mismatch'
    );
    computedVoteKey.assertEquals(
      voteNullifierKey,
      'Vote nullifier key mismatch'
    );

    const [newVoteRoot] = voteNullifierWitness.computeRootAndKey(Field(1));
    this.voteNullifierRoot.set(newVoteRoot);

    // Approval count: keyed by proposalHash
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(currentApprovalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    const newApprovalCount = currentApprovalCount.add(1);
    const [newApprovalRoot] =
      approvalWitness.computeRootAndKey(newApprovalCount);
    this.approvalRoot.set(newApprovalRoot);

    this.emitEvent('approval', {
      proposalHash,
      approver,
      approvalCount: newApprovalCount,
    });
  }

  @method async executeTransfer(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field
  ) {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    proposal.txType.assertEquals(TxType.TRANSFER, 'Not a transfer tx');

    const proposalHash = proposal.hash();

    // Verify config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(
      currentConfigNonce,
      'Config nonce mismatch - governance changed since proposal'
    );

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    // Check expiry (0 = no expiry)
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.getAndRequireEquals();
    const notExpired = blockchainLength.value.lessThanOrEqual(
      proposal.expiryBlock
    );
    noExpiry.or(notExpired).assertTrue('Proposal expired');

    // Prevent re-execution
    approvalCount
      .equals(EXECUTED_MARKER)
      .assertFalse('Proposal already executed');

    // Verify threshold (approvalCount includes PROPOSED_MARKER offset)
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.sub(PROPOSED_MARKER).assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval count via witness (keyed by proposalHash)
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    // Execute transfer
    this.send({ to: proposal.to, amount: proposal.amount });

    // Mark as executed
    const [newApprovalRoot] =
      approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);

    this.emitEvent('execution', {
      proposalHash,
      to: proposal.to,
      amount: proposal.amount,
      txType: proposal.txType,
    });
  }

  @method async executeOwnerChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    ownerPubKey: PublicKey,
    ownerWitness: MerkleMapWitness
  ) {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    // Must be ADD_OWNER or REMOVE_OWNER
    const isAdd = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemove = proposal.txType.equals(TxType.REMOVE_OWNER);
    isAdd.or(isRemove).assertTrue('Not an owner change tx');

    const proposalHash = proposal.hash();

    // Verify config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(
      currentConfigNonce,
      'Config nonce mismatch'
    );

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    // Check expiry
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.getAndRequireEquals();
    const notExpired = blockchainLength.value.lessThanOrEqual(
      proposal.expiryBlock
    );
    noExpiry.or(notExpired).assertTrue('Proposal expired');

    // Prevent re-execution
    approvalCount
      .equals(EXECUTED_MARKER)
      .assertFalse('Proposal already executed');

    // Verify threshold (approvalCount includes PROPOSED_MARKER offset)
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.sub(PROPOSED_MARKER).assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval witness (keyed by proposalHash)
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    // Verify proposal data matches owner
    const ownerHash = ownerKey(ownerPubKey);
    proposal.data.assertEquals(ownerHash, 'Data does not match owner');

    const numOwners = this.numOwners.getAndRequireEquals();

    // For ADD: owner must NOT be in map (value = 0)
    // For REMOVE: owner must be in map (value = 1)
    const expectedValue = isRemove.toField(); // 0 for add, 1 for remove
    const [computedOwnerRoot, computedOwnerKey] =
      ownerWitness.computeRootAndKey(expectedValue);
    computedOwnerRoot.assertEquals(ownersRoot, 'Owner root mismatch');
    computedOwnerKey.assertEquals(ownerHash, 'Owner key mismatch');

    // For REMOVE: ensure numOwners - 1 >= threshold
    // For ADD: this check trivially passes since numOwners + 1 >= threshold
    const newNumOwners = numOwners.add(isAdd.toField()).sub(isRemove.toField());
    newNumOwners.assertGreaterThanOrEqual(
      threshold,
      'Cannot remove: would go below threshold'
    );

    // Update owner map: ADD sets to 1, REMOVE sets to 0
    const newValue = isAdd.toField(); // 1 for add, 0 for remove
    const [newOwnersRoot] = ownerWitness.computeRootAndKey(newValue);
    this.ownersRoot.set(newOwnersRoot);
    this.numOwners.set(newNumOwners);

    // Mark as executed
    const [newApprovalRoot] =
      approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);

    // Increment config nonce
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('ownerChange', {
      owner: ownerPubKey,
      added: isAdd.toField(),
      newNumOwners,
    });
  }

  @method async executeThresholdChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    newThreshold: Field
  ) {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    proposal.txType.assertEquals(
      TxType.CHANGE_THRESHOLD,
      'Not a threshold change tx'
    );

    const proposalHash = proposal.hash();

    // Verify config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(
      currentConfigNonce,
      'Config nonce mismatch'
    );

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    // Check expiry
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.getAndRequireEquals();
    const notExpired = blockchainLength.value.lessThanOrEqual(
      proposal.expiryBlock
    );
    noExpiry.or(notExpired).assertTrue('Proposal expired');

    // Prevent re-execution
    approvalCount
      .equals(EXECUTED_MARKER)
      .assertFalse('Proposal already executed');

    // Verify threshold (using current, approvalCount includes PROPOSED_MARKER offset)
    const currentThreshold = this.threshold.getAndRequireEquals();
    approvalCount.sub(PROPOSED_MARKER).assertGreaterThanOrEqual(
      currentThreshold,
      'Insufficient approvals'
    );

    // Verify approval witness (keyed by proposalHash)
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    // Verify data matches new threshold
    proposal.data.assertEquals(
      newThreshold,
      'Data does not match new threshold'
    );

    // Validate new threshold
    newThreshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    const numOwners = this.numOwners.getAndRequireEquals();
    numOwners.assertGreaterThanOrEqual(
      newThreshold,
      'Threshold cannot exceed owner count'
    );

    this.threshold.set(newThreshold);

    // Mark as executed
    const [newApprovalRoot] =
      approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);

    // Increment config nonce
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('thresholdChange', {
      oldThreshold: currentThreshold,
      newThreshold,
    });
  }

  @method async executeDelegate(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    delegate: PublicKey
  ) {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');

    proposal.txType.assertEquals(
      TxType.SET_DELEGATE,
      'Not a delegate tx'
    );

    const proposalHash = proposal.hash();

    // Verify config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(
      currentConfigNonce,
      'Config nonce mismatch'
    );

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');

    // Check expiry
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.getAndRequireEquals();
    const notExpired = blockchainLength.value.lessThanOrEqual(
      proposal.expiryBlock
    );
    noExpiry.or(notExpired).assertTrue('Proposal expired');

    // Prevent re-execution
    approvalCount
      .equals(EXECUTED_MARKER)
      .assertFalse('Proposal already executed');

    // Verify threshold (approvalCount includes PROPOSED_MARKER offset)
    const threshold = this.threshold.getAndRequireEquals();
    approvalCount.sub(PROPOSED_MARKER).assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );

    // Verify approval witness (keyed by proposalHash)
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(approvalCount);
    computedApprovalRoot.assertEquals(
      approvalRoot,
      'Approval root mismatch'
    );
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');

    // Un-delegation: data == 0 means delegate to self
    // Delegation: data must match hash of delegate pubkey
    const isUndelegate = proposal.data.equals(Field(0));
    const delegateHash = ownerKey(delegate);
    isUndelegate
      .or(proposal.data.equals(delegateHash))
      .assertTrue('Data does not match delegate');

    // Set delegate: self for un-delegation, delegate pubkey otherwise
    const targetDelegate = Provable.if(isUndelegate, PublicKey, this.address, delegate);
    this.account.delegate.set(targetDelegate);

    // Mark as executed
    const [newApprovalRoot] =
      approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);

    // TODO: re-evaluate whether delegation should invalidate pending proposals (increment configNonce)

    this.emitEvent('delegate', {
      delegate: targetDelegate,
    });
  }
}
