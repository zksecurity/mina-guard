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

/** Marker value indicating a proposal exists with zero approvals. */
export const PROPOSED_MARKER = Field(1);
/** Sentinel value used to mark a proposal as executed. */
export const EXECUTED_MARKER = Field(0).sub(1);
/** Empty MerkleMap root used during one-time setup initialization. */
export const EMPTY_MERKLE_MAP_ROOT = new MerkleMap().getRoot();
/** Fixed upper bound for setup owner event emission and setup inputs. */
export const MAX_SETUP_OWNERS = 20;

/** Supported MinaGuard proposal action types. */
export const TxType = {
  TRANSFER: Field(0),
  ADD_OWNER: Field(1),
  REMOVE_OWNER: Field(2),
  CHANGE_THRESHOLD: Field(3),
  SET_DELEGATE: Field(4),
};

// -- Helper ------------------------------------------------------------------

/** Computes the owner membership key used in the owner Merkle map. */
export function ownerKey(owner: PublicKey): Field {
  return Poseidon.hash(owner.toFields());
}

// -- Types -------------------------------------------------------------------

/**
 * Canonical proposal payload hashed for signatures and proposal indexing.
 * All fields participate in hash() to prevent replay/substitution attacks.
 */
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
  guardAddress: PublicKey,
}) {
  /** Returns the unique proposal hash used as map key and signature message. */
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
      ...this.guardAddress.toFields(),
    ]);
  }
}

/** Fixed-size setup owner input used by the setup method. */
export class SetupOwnersInput extends Struct({
  owners: Provable.Array(PublicKey, MAX_SETUP_OWNERS),
}) { }

// -- Witness Wrappers --------------------------------------------------------

/** Typed wrapper for owner map witnesses. */
export class OwnerWitness extends Struct({
  witness: MerkleMapWitness,
}) { }

/** Typed wrapper for approval map witnesses. */
export class ApprovalWitness extends Struct({
  witness: MerkleMapWitness,
}) { }

/** Typed wrapper for vote nullifier map witnesses. */
export class VoteNullifierWitness extends Struct({
  witness: MerkleMapWitness,
}) { }

// -- Events ------------------------------------------------------------------

/** Emitted once per deploy transaction for contract discovery. */
export class DeployEvent extends Struct({
  guardAddress: PublicKey,
}) { }

/** Emitted during setup with contract-level bootstrap metadata. */
export class SetupEvent extends Struct({
  ownersRoot: Field,
  threshold: Field,
  numOwners: Field,
  networkId: Field,
}) { }

/** Emitted for each setup owner slot (fixed-size array with active flag). */
export class SetupOwnerEvent extends Struct({
  owner: PublicKey,
  index: Field,
  active: Field,
}) { }

/** Emitted when a new proposal is created and indexed by proposalHash. */
export class ProposalEvent extends Struct({
  proposalHash: Field,
  proposer: PublicKey,
  to: PublicKey,
  amount: UInt64,
  tokenId: Field,
  txType: Field,
  data: Field,
  nonce: Field,
  configNonce: Field,
  expiryBlock: Field,
  networkId: Field,
  guardAddress: PublicKey,
}) { }

/** Emitted whenever a valid owner approval is recorded. */
export class ApprovalEvent extends Struct({
  proposalHash: Field,
  approver: PublicKey,
  approvalCount: Field,
}) { }

/** Emitted for all execution paths to provide a unified lifecycle signal. */
export class ExecutionEvent extends Struct({
  proposalHash: Field,
  to: PublicKey,
  amount: UInt64,
  txType: Field,
}) { }

/** Emitted after owner add/remove execution with proposal linkage. */
export class OwnerChangeEvent extends Struct({
  proposalHash: Field,
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
}) { }

/** Emitted after threshold change execution with proposal linkage. */
export class ThresholdChangeEvent extends Struct({
  proposalHash: Field,
  oldThreshold: Field,
  newThreshold: Field,
}) { }

/** Emitted after delegate execution with proposal linkage. */
export class DelegateEvent extends Struct({
  proposalHash: Field,
  delegate: PublicKey,
}) { }

// -- Contract ----------------------------------------------------------------

/**
 * MinaGuard multisig contract.
 * Stores compact roots and counters on-chain while using witnesses for membership and approvals.
 */
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
    deployed: DeployEvent,
    setup: SetupEvent,
    setupOwner: SetupOwnerEvent,
    proposal: ProposalEvent,
    approval: ApprovalEvent,
    execution: ExecutionEvent,
    ownerChange: OwnerChangeEvent,
    thresholdChange: ThresholdChangeEvent,
    delegate: DelegateEvent,
  };

  /** Configures account permissions and emits a deploy discovery event. */
  async deploy() {
    await super.deploy();
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof(),
      send: Permissions.proof(),
      receive: Permissions.none(),
      setDelegate: Permissions.proof(),
      setPermissions: Permissions.proof(),
    });

    this.emitEvent('deployed', {
      guardAddress: this.address,
    });
  }

  /** Reads and asserts wallet initialization state. */
  private getInitializedOwnersRoot(): Field {
    const ownersRoot = this.ownersRoot.getAndRequireEquals();
    ownersRoot.assertNotEquals(Field(0), 'Wallet not initialized');
    return ownersRoot;
  }

  /** Verifies that an address is an owner using a Merkle witness. */
  private assertOwnerMembership(
    owner: PublicKey,
    ownerWitness: MerkleMapWitness,
    ownersRoot: Field
  ): void {
    const key = ownerKey(owner);
    const [computedRoot, computedKey] = ownerWitness.computeRootAndKey(Field(1));
    computedRoot.assertEquals(ownersRoot, 'Not an owner');
    computedKey.assertEquals(key, 'Owner key mismatch');
  }

  /** Validates proposal binding to current config nonce, network and contract address. */
  private assertProposalConfigNetworkAndGuard(
    proposal: TransactionProposal,
    configNonceMessage: string
  ): void {
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    proposal.configNonce.assertEquals(currentConfigNonce, configNonceMessage);

    const currentNetworkId = this.networkId.getAndRequireEquals();
    proposal.networkId.assertEquals(currentNetworkId, 'Network ID mismatch');
    proposal.guardAddress.assertEquals(this.address);
  }

  /** Asserts optional expiry block has not passed. */
  private assertProposalNotExpired(proposal: TransactionProposal): void {
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.getAndRequireEquals();
    const notExpired = blockchainLength.value.lessThanOrEqual(proposal.expiryBlock);
    noExpiry.or(notExpired).assertTrue('Proposal expired');
  }

  /** Rejects proposal lifecycle actions on executed proposals. */
  private assertNotExecuted(approvalCount: Field): void {
    approvalCount.equals(EXECUTED_MARKER).assertFalse('Proposal already executed');
  }

  /** Rejects lifecycle actions if proposal was never registered. */
  private assertProposalExists(approvalCount: Field): void {
    approvalCount.assertGreaterThanOrEqual(PROPOSED_MARKER, 'Proposal not found');
  }

  /** Verifies approvals satisfy threshold after marker offset normalization. */
  private assertThresholdSatisfied(approvalCount: Field, threshold: Field): void {
    approvalCount.sub(PROPOSED_MARKER).assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );
  }

  /** Verifies approval witness root/key/value at proposalHash. */
  private assertApprovalWitnessValue(
    proposalHash: Field,
    approvalWitness: MerkleMapWitness,
    expectedValue: Field
  ): void {
    const approvalRoot = this.approvalRoot.getAndRequireEquals();
    const [computedApprovalRoot, computedApprovalKey] =
      approvalWitness.computeRootAndKey(expectedValue);
    computedApprovalRoot.assertEquals(approvalRoot, 'Approval root mismatch');
    computedApprovalKey.assertEquals(proposalHash, 'Approval key mismatch');
  }

  /** Marks a proposal as executed in approval root using sentinel value. */
  private markExecuted(approvalWitness: MerkleMapWitness): void {
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);
  }

  /**
   * One-time initialization for ownership and quorum config.
   * Emits fixed-size owner bootstrap events for indexers.
   */
  @method async setup(
    ownersRoot: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field,
    initialOwners: SetupOwnersInput
  ) {
    const currentRoot = this.ownersRoot.getAndRequireEquals();
    currentRoot.assertEquals(Field(0), 'Already initialized');

    threshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      threshold,
      'Owners must be >= threshold'
    );
    numOwners.assertLessThanOrEqual(Field(MAX_SETUP_OWNERS), 'Too many owners');

    this.ownersRoot.set(ownersRoot);
    this.threshold.set(threshold);
    this.numOwners.set(numOwners);
    this.approvalRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.voteNullifierRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.networkId.set(networkId);

    for (let i = 0; i < MAX_SETUP_OWNERS; i++) {
      const index = Field(i);
      const active = index.lessThan(numOwners);
      this.emitEvent('setupOwner', {
        owner: Provable.if(active, PublicKey, initialOwners.owners[i], PublicKey.empty()),
        index,
        active: active.toField(),
      });
    }
  }

  /**
   * Proposes a new transaction and records the proposer's first approval.
   * This preserves current contract behavior expected by tests and UI.
   */
  @method async propose(
    proposal: TransactionProposal,
    ownerWitness: MerkleMapWitness,
    proposer: PublicKey,
    signature: Signature,
    voteNullifierWitness: MerkleMapWitness,
    approvalWitness: MerkleMapWitness
  ) {
    const ownersRoot = this.getInitializedOwnersRoot();
    this.assertOwnerMembership(proposer, ownerWitness, ownersRoot);

    const currentNonce = this.proposalNonce.getAndRequireEquals();
    proposal.nonce.assertEquals(currentNonce, 'Nonce mismatch');

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');

    const proposalHash = proposal.hash();

    this.proposalNonce.set(currentNonce.add(1));

    signature.verify(proposer, [proposalHash]).assertTrue('Invalid signature');

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

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const [newApprovalRoot] = approvalWitness.computeRootAndKey(PROPOSED_MARKER.add(1));
    this.approvalRoot.set(newApprovalRoot);

    this.emitEvent('proposal', {
      proposalHash,
      proposer,
      to: proposal.to,
      amount: proposal.amount,
      tokenId: proposal.tokenId,
      txType: proposal.txType,
      data: proposal.data,
      nonce: proposal.nonce,
      configNonce: proposal.configNonce,
      expiryBlock: proposal.expiryBlock,
      networkId: proposal.networkId,
      guardAddress: proposal.guardAddress,
    });

    this.emitEvent('approval', {
      proposalHash,
      approver: proposer,
      approvalCount: Field(1),
    });
  }

  /** Verifies and records a non-proposer owner approval for an existing proposal. */
  @method async approveProposal(
    proposal: TransactionProposal,
    signature: Signature,
    approver: PublicKey,
    ownerWitness: MerkleMapWitness,
    approvalWitness: MerkleMapWitness,
    currentApprovalCount: Field,
    voteNullifierWitness: MerkleMapWitness
  ) {
    const ownersRoot = this.getInitializedOwnersRoot();
    this.assertOwnerMembership(approver, ownerWitness, ownersRoot);
    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');

    const proposalHash = proposal.hash();
    signature.verify(approver, [proposalHash]).assertTrue('Invalid signature');

    this.assertNotExecuted(currentApprovalCount);
    this.assertProposalExists(currentApprovalCount);

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

    this.assertApprovalWitnessValue(
      proposalHash,
      approvalWitness,
      currentApprovalCount
    );

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

  /** Executes transfer proposals once threshold and lifecycle checks pass. */
  @method async executeTransfer(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field
  ) {
    this.getInitializedOwnersRoot();

    proposal.txType.assertEquals(TxType.TRANSFER, 'Not a transfer tx');

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(
      proposal,
      'Config nonce mismatch - governance changed since proposal'
    );

    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const threshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    this.send({ to: proposal.to, amount: proposal.amount });

    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      to: proposal.to,
      amount: proposal.amount,
      txType: proposal.txType,
    });
  }

  /** Executes owner add/remove proposals and updates config nonce after success. */
  @method async executeOwnerChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    ownerPubKey: PublicKey,
    ownerWitness: MerkleMapWitness
  ) {
    const ownersRoot = this.getInitializedOwnersRoot();

    const isAdd = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemove = proposal.txType.equals(TxType.REMOVE_OWNER);
    isAdd.or(isRemove).assertTrue('Not an owner change tx');

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const threshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    const ownerHash = ownerKey(ownerPubKey);
    proposal.data.assertEquals(ownerHash, 'Data does not match owner');

    const numOwners = this.numOwners.getAndRequireEquals();

    const expectedValue = isRemove.toField();
    const [computedOwnerRoot, computedOwnerKey] =
      ownerWitness.computeRootAndKey(expectedValue);
    computedOwnerRoot.assertEquals(ownersRoot, 'Owner root mismatch');
    computedOwnerKey.assertEquals(ownerHash, 'Owner key mismatch');

    const newNumOwners = numOwners.add(isAdd.toField()).sub(isRemove.toField());
    newNumOwners.assertGreaterThanOrEqual(
      threshold,
      'Cannot remove: would go below threshold'
    );

    const newValue = isAdd.toField();
    const [newOwnersRoot] = ownerWitness.computeRootAndKey(newValue);
    this.ownersRoot.set(newOwnersRoot);
    this.numOwners.set(newNumOwners);

    this.markExecuted(approvalWitness);

    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('execution', {
      proposalHash,
      to: PublicKey.empty(),
      amount: UInt64.from(0),
      txType: proposal.txType,
    });

    this.emitEvent('ownerChange', {
      proposalHash,
      owner: ownerPubKey,
      added: isAdd.toField(),
      newNumOwners,
    });
  }

  /** Executes threshold change proposals and bumps config nonce on success. */
  @method async executeThresholdChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    newThreshold: Field
  ) {
    this.getInitializedOwnersRoot();

    proposal.txType.assertEquals(
      TxType.CHANGE_THRESHOLD,
      'Not a threshold change tx'
    );

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const currentThreshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, currentThreshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    proposal.data.assertEquals(
      newThreshold,
      'Data does not match new threshold'
    );

    newThreshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    const numOwners = this.numOwners.getAndRequireEquals();
    numOwners.assertGreaterThanOrEqual(
      newThreshold,
      'Threshold cannot exceed owner count'
    );

    this.threshold.set(newThreshold);

    this.markExecuted(approvalWitness);

    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('execution', {
      proposalHash,
      to: PublicKey.empty(),
      amount: UInt64.from(0),
      txType: proposal.txType,
    });

    this.emitEvent('thresholdChange', {
      proposalHash,
      oldThreshold: currentThreshold,
      newThreshold,
    });
  }

  /** Executes delegate/undelegate proposals once threshold and data checks pass. */
  @method async executeDelegate(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    delegate: PublicKey
  ) {
    this.getInitializedOwnersRoot();

    proposal.txType.assertEquals(
      TxType.SET_DELEGATE,
      'Not a delegate tx'
    );

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const threshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    const isUndelegate = proposal.data.equals(Field(0));
    const delegateHash = ownerKey(delegate);
    isUndelegate
      .or(proposal.data.equals(delegateHash))
      .assertTrue('Data does not match delegate');

    const targetDelegate = Provable.if(isUndelegate, PublicKey, this.address, delegate);
    this.account.delegate.set(targetDelegate);

    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      to: targetDelegate,
      amount: UInt64.from(0),
      txType: proposal.txType,
    });

    this.emitEvent('delegate', {
      proposalHash,
      delegate: targetDelegate,
    });
  }
}
