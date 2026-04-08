import {
  SmartContract,
  state,
  State,
  method,
  Field,
  PublicKey,
  Permissions,
  MerkleMapWitness,
  Poseidon,
  Bool,
  Provable,
  Signature,
  Struct,
  UInt32,
  UInt64,
} from 'o1js';

import { ownerKey } from './utils';

import {
  MAX_OWNERS,
  MAX_RECEIVERS,
  PROPOSED_MARKER,
  EXECUTED_MARKER,
  EMPTY_MERKLE_MAP_ROOT,
  TxType,
  Destination,
} from './constants';

import { addOwnerToCommitment, removeOwnerFromCommitment, assertOwnerMembership, OwnerWitness, PublicKeyOption } from './list-commitment';
import { batchVerify, SignatureInputs } from './batch-verify';

// -- Types -------------------------------------------------------------------

/** A single receiver slot: address + amount. Empty slots use PublicKey.empty() and UInt64(0). */
export class Receiver extends Struct({
  address: PublicKey,
  amount: UInt64,
}) {
  static empty(): Receiver {
    return new Receiver({ address: PublicKey.empty(), amount: UInt64.from(0) });
  }
}

const ReceiversArray = Provable.Array(Receiver, MAX_RECEIVERS);

/**
 * Canonical proposal payload hashed for signatures and proposal indexing.
 * All fields participate in hash() to prevent replay/substitution attacks.
 *
 * Transfers support up to MAX_RECEIVERS recipients per proposal.
 * Unused receiver slots must use Receiver.empty().
 * Non-transfer proposals (governance, delegation) use all-empty receiver slots.
 */
export class TransactionProposal extends Struct({
  receivers: ReceiversArray,
  tokenId: Field,
  txType: Field,
  data: Field,
  uid: Field,
  configNonce: Field,
  expiryBlock: Field,
  networkId: Field,
  guardAddress: PublicKey,
  destination: Field,
  childAccount: PublicKey,
}) {
  /** Returns the unique proposal hash used as map key and signature message. */
  hash(): Field {
    const fields: Field[] = [];
    for (let i = 0; i < MAX_RECEIVERS; i++) {
      fields.push(...Receiver.toFields(this.receivers[i]));
    }
    return Poseidon.hash([
      ...fields,
      this.tokenId,
      this.txType,
      this.data,
      this.uid,
      this.configNonce,
      this.expiryBlock,
      this.networkId,
      ...this.guardAddress.toFields(),
      this.destination,
      ...this.childAccount.toFields(),
    ]);
  }
}

/** Fixed-size setup owner input used by the setup method. */
export class SetupOwnersInput extends Struct({
  owners: Provable.Array(PublicKey, MAX_OWNERS),
}) { }

// -- Events ------------------------------------------------------------------

/** Emitted once per deploy transaction for contract discovery. */
export class DeployEvent extends Struct({
  guardAddress: PublicKey,
}) { }

/** Emitted during setup with contract-level bootstrap metadata. */
export class SetupEvent extends Struct({
  ownersCommitment: Field,
  threshold: Field,
  numOwners: Field,
  networkId: Field,
  parent: PublicKey,
}) { }

/** Emitted for each setup owner slot (fixed-size array). */
export class SetupOwnerEvent extends Struct({
  owner: PublicKey,
  index: Field,
}) { }

/**
 * Emitted when a new proposal is created and indexed by proposalHash.
 * Receiver/amount data is emitted via TransferEvent (one per MAX_RECEIVERS
 * slot, padded with empties) since Mina limits events to 16 field elements.
 */
export class ProposalEvent extends Struct({
  proposalHash: Field,
  proposer: PublicKey,
  tokenId: Field,
  txType: Field,
  data: Field,
  uid: Field,
  configNonce: Field,
  expiryBlock: Field,
  networkId: Field,
  guardAddress: PublicKey,
  destination: Field,
  childAccount: PublicKey,
}) { }

/** Emitted once per receiver slot during propose and execution (fixed-size, padded with empties). */
export class TransferEvent extends Struct({
  proposalHash: Field,
  receiver: PublicKey,
  amount: UInt64,
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
  txType: Field,
}) { }

export class ExecutionBatchEvent extends Struct({
  proposalHash: Field,
  txType: Field,
  approverChain: Field,
}) { }

export class OwnerChangeEvent extends Struct({
  proposalHash: Field,
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
  configNonce: Field,
}) { }

export class OwnerChangeBatchEvent extends Struct({
  proposalHash: Field,
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
  configNonce: Field,
  approverChain: Field,
}) { }

export class ThresholdChangeEvent extends Struct({
  proposalHash: Field,
  oldThreshold: Field,
  newThreshold: Field,
  configNonce: Field,
}) { }

export class ThresholdChangeBatchEvent extends Struct({
  proposalHash: Field,
  oldThreshold: Field,
  newThreshold: Field,
  configNonce: Field,
  approverChain: Field,
}) { }

export class DelegateEvent extends Struct({
  proposalHash: Field,
  delegate: PublicKey,
}) { }

export class DelegateBatchEvent extends Struct({
  proposalHash: Field,
  delegate: PublicKey,
  approverChain: Field,
}) { }

export class CreateChildEvent extends Struct({
  proposalHash: Field,
  childAddress: PublicKey,
  parentAddress: PublicKey,
  ownersCommitment: Field,
  threshold: Field,
  numOwners: Field,
}) { }

export class AllocateChildEvent extends Struct({
  proposalHash: Field,
  childAddress: PublicKey,
  amount: UInt64,
}) { }

export class ReclaimChildEvent extends Struct({
  proposalHash: Field,
  amount: UInt64,
}) { }

export class DestroyChildEvent extends Struct({
  proposalHash: Field,
  reclaimedAmount: UInt64,
}) { }

export class TogglePolicyEvent extends Struct({
  proposalHash: Field,
  enabled: Field,
}) { }

// -- Contract ----------------------------------------------------------------

/**
 * MinaGuard multisig contract.
 * Stores compact roots and counters on-chain while using witnesses for membership and approvals.
 */
export class MinaGuard extends SmartContract {
  @state(Field) ownersCommitment = State<Field>();
  @state(Field) threshold = State<Field>();
  @state(Field) numOwners = State<Field>();
  @state(Field) proposalCounter = State<Field>();
  @state(Field) voteNullifierRoot = State<Field>();
  @state(Field) approvalRoot = State<Field>();
  @state(Field) configNonce = State<Field>();
  @state(Field) networkId = State<Field>();
  @state(PublicKey) parent = State<PublicKey>();
  @state(Field) childExecutionRoot = State<Field>();
  @state(Field) policyEnabled = State<Field>();

  events = {
    deployed: DeployEvent,
    setup: SetupEvent,
    setupOwner: SetupOwnerEvent,
    proposal: ProposalEvent,
    transfer: TransferEvent,
    approval: ApprovalEvent,
    execution: ExecutionEvent,
    executionBatch: ExecutionBatchEvent,
    ownerChange: OwnerChangeEvent,
    ownerChangeBatch: OwnerChangeBatchEvent,
    thresholdChange: ThresholdChangeEvent,
    thresholdChangeBatch: ThresholdChangeBatchEvent,
    delegate: DelegateEvent,
    delegateBatch: DelegateBatchEvent,
    createChild: CreateChildEvent,
    allocateChild: AllocateChildEvent,
    reclaimChild: ReclaimChildEvent,
    destroyChild: DestroyChildEvent,
    togglePolicy: TogglePolicyEvent,
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
      setPermissions: Permissions.impossible(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setZkappUri: Permissions.impossible(),
      setTokenSymbol: Permissions.impossible(),
      incrementNonce: Permissions.impossible(),
      setVotingFor: Permissions.impossible(),
      setTiming: Permissions.impossible(),
    });

    this.emitEvent('deployed', {
      guardAddress: this.address,
    });
  }

  private getInitializedOwnersCommitment(): Field {
    const ownersCommitment = this.ownersCommitment.getAndRequireEquals();
    ownersCommitment.assertNotEquals(Field(0), 'Wallet not initialized');
    return ownersCommitment;
  }

  /** Verifies that an address is an owner using a Merkle witness. */
  private assertOwnerMembership(
    owner: PublicKey,
    ownerWitness: OwnerWitness,
    ownersCommitment: Field
  ): void {
    assertOwnerMembership(ownersCommitment, owner, ownerWitness);
  }

  private assertMerkleWitnessValue(
    expectedRoot: Field,
    expectedKey: Field,
    witness: MerkleMapWitness,
    expectedValue: Field,
    rootErrorMessage: string,
    keyErrorMessage: string
  ): void {
    const [computedRoot, computedKey] = witness.computeRootAndKey(expectedValue);
    computedRoot.assertEquals(expectedRoot, rootErrorMessage);
    computedKey.assertEquals(expectedKey, keyErrorMessage);
  }

  private getGovernanceState(): { threshold: Field; numOwners: Field } {
    const threshold = this.threshold.getAndRequireEquals();
    const numOwners = this.numOwners.getAndRequireEquals();

    return { threshold, numOwners };
  }

  private setGovernanceState(threshold: Field, numOwners: Field): void {
    this.threshold.set(threshold);
    this.numOwners.set(numOwners);
  }

  private assertPolicyEnabledIfChild(): void {
    const parent = this.parent.getAndRequireEquals();
    const isChild = parent.equals(PublicKey.empty()).not();
    const policyEnabled = this.policyEnabled.getAndRequireEquals();
    // Either is not a child or is a child and policy is enabled
    isChild.not().or(policyEnabled.equals(Field(1))).assertTrue('Independent policy disabled');
  }

  private assertLocalProposal(proposal: TransactionProposal): void {
    proposal.destination.assertEquals(
      Destination.LOCAL,
      'Not a local destination proposal'
    );
  }

  private assertValidRemoteProposal(proposal: TransactionProposal): void {
    proposal.destination.assertEquals(
      Destination.REMOTE,
      'Not a remote destination proposal'
    );
    proposal.childAccount.equals(this.address)
      .assertTrue('Proposal not for this child');
  }

  private assertCurrAccountIsChild(parent: PublicKey): void {
    parent.equals(PublicKey.empty()).assertFalse('Not a child account');
  }

  private assertValidProposalConfigNetworkAndGuard(
    proposal: TransactionProposal,
    configNonce: Field,
    networkId: Field,
    guardAddress: PublicKey,
  ): void {
    proposal.configNonce.assertEquals(configNonce, 'Config nonce mismatch - governance changed since proposal',);
    proposal.networkId.assertEquals(networkId, 'Network ID mismatch');
    proposal.guardAddress.equals(guardAddress).assertTrue('Guard address mismatch');
  }

  /** Validates proposal binding to current config nonce, network and contract address. */
  private assertProposalConfigNetworkAndGuard(
    proposal: TransactionProposal,
  ): void {
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    const currentNetworkId = this.networkId.getAndRequireEquals();
    this.assertValidProposalConfigNetworkAndGuard(
      proposal,
      currentConfigNonce,
      currentNetworkId,
      this.address
    );
  }

  // Checks that:
  //   1. Proposal either has remote destination or has local destination and does not target child accounts
  //   2. Proposal either has local destination or has remote destination and is not a child account
  private assertProposalDestinationAndChildAccount(proposal: TransactionProposal): void {
    const isDestinationLocal = proposal.destination.equals(Destination.LOCAL);
    const isDestinationRemote = proposal.destination.equals(Destination.REMOTE);
    isDestinationLocal.or(isDestinationRemote).assertTrue('Invalid execution mode');

    const isNotTargetingChildAccount = proposal.childAccount.equals(PublicKey.empty());
    isDestinationRemote
      .or(isNotTargetingChildAccount)
      .assertTrue('Local destination (Parent or Child) proposals cannot target child accounts');

    const isParent = this.parent.getAndRequireEquals().equals(PublicKey.empty());
    isDestinationLocal
      .or(isParent)
      .assertTrue('Remote destination proposals must be proposed/approved on a parent account');
  }

  /** Asserts optional expiry block has not passed. */
  private assertProposalNotExpired(proposal: TransactionProposal): void {
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.get();
    // Use a range precondition so the tx isn't rejected when the block advances
    // between proof generation and inclusion. For proposals with an expiry, the
    // upper bound is the expiry block; for no-expiry proposals it's uncapped.
    this.network.blockchainLength.requireBetween(
      UInt32.from(0),
      Provable.if(noExpiry, UInt32, UInt32.MAXINT(), UInt32.Unsafe.fromField(proposal.expiryBlock))
    );
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
    this.assertMerkleWitnessValue(
      approvalRoot,
      proposalHash,
      approvalWitness,
      expectedValue,
      'Approval root mismatch',
      'Approval key mismatch'
    );
  }

  /** Marks a proposal as executed in approval root using sentinel value. */
  private markExecuted(approvalWitness: MerkleMapWitness): void {
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);
  }

  /** Emits a transfer event per receiver slot (padded with empties). */
  private emitTransferEvents(proposal: TransactionProposal, proposalHash: Field): void {
    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.emitEvent('transfer', { proposalHash, receiver: r.address, amount: effectiveAmount });
    }
  }

  /** Verifies batch signatures from parent owners against the parent's on-chain state. */
  private verifyParentBatchSig(
    proposal: TransactionProposal,
    parentAddress: PublicKey,
    sigs: SignatureInputs,
  ): Field {
    const parentGuard = new MinaGuard(parentAddress);
    const parentOwnersCommitment = parentGuard.ownersCommitment.getAndRequireEquals();
    parentOwnersCommitment.assertNotEquals(Field(0), 'Parent not initialized');

    const parentConfigNonce = parentGuard.configNonce.getAndRequireEquals();
    const parentNetworkId = parentGuard.networkId.getAndRequireEquals();
    this.assertValidProposalConfigNetworkAndGuard(
      proposal,
      parentConfigNonce,
      parentNetworkId,
      parentAddress,
    );

    this.assertProposalNotExpired(proposal);

    const proposalHash = proposal.hash();
    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(parentOwnersCommitment, 'Owner list mismatch');

    const { threshold: parentThreshold } = parentGuard.getGovernanceState();
    verificationRes.approvalCount.assertGreaterThanOrEqual(parentThreshold, 'Insufficient approvals');

    return proposalHash;
  }

  /** Sends MINA to each receiver slot and emits transfer events. */
  private executeTransfers(proposal: TransactionProposal, proposalHash: Field): void {
    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.send({ to: r.address, amount: effectiveAmount });
      this.emitEvent('transfer', { proposalHash, receiver: r.address, amount: effectiveAmount });
    }
  }

  private assertChildExecutionWitnessValue(
    proposalHash: Field,
    childExecutionWitness: MerkleMapWitness,
    expectedValue: Field
  ): void {
    this.assertMerkleWitnessValue(
      this.childExecutionRoot.getAndRequireEquals(),
      proposalHash,
      childExecutionWitness,
      expectedValue,
      'Child execution root mismatch',
      'Child execution key mismatch'
    );
  }

  private markChildExecuted(childExecutionWitness: MerkleMapWitness): void {
    const [newChildExecutionRoot] =
      childExecutionWitness.computeRootAndKey(EXECUTED_MARKER);
    this.childExecutionRoot.set(newChildExecutionRoot);
  }

  /** Shared initialization: validates config, sets all state, emits setup + owner events. */
  private initializeState(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field,
    parent: PublicKey,
    initialOwners: SetupOwnersInput,
  ): void {
    // Use requireEquals instead of getAndRequireEquals so deploy+setup can
    // be combined in a single transaction (no account cache read needed).
    this.ownersCommitment.requireEquals(Field(0));
    ownersCommitment.assertNotEquals(Field(0), 'Owners commitment must not be zero');

    threshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      threshold,
      'Owners must be >= threshold'
    );
    numOwners.assertLessThanOrEqual(Field(MAX_OWNERS), 'Too many owners');

    this.ownersCommitment.set(ownersCommitment);
    this.setGovernanceState(threshold, numOwners);
    this.approvalRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.voteNullifierRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.networkId.set(networkId);
    this.parent.set(parent);
    this.childExecutionRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.policyEnabled.set(Field(1));

    this.emitEvent('setup', { ownersCommitment, threshold, numOwners, networkId, parent });

    for (let i = 0; i < MAX_OWNERS; i++) {
      const index = Field(i);
      const active = index.lessThan(numOwners);
      this.emitEvent('setupOwner', {
        owner: Provable.if(active, PublicKey, initialOwners.owners[i], PublicKey.empty()),
        index,
      });
    }
  }

  /**
   * Initializes a root guard (no parent). Cannot call twice.
   *
   * IMPORTANT: Assuming an untrusted deployer, a client must compute the expected commitment
   * themselves and cross-check with the one on chain. numOwners as well, for sync.
   */
  @method async setup(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field,
    initialOwners: SetupOwnersInput
  ) {
    this.initializeState(ownersCommitment, threshold, numOwners, networkId, PublicKey.empty(), initialOwners);
  }

  /**
   * Initializes a child guard linked to a parent. Parent owners sign off on
   * a CREATE_CHILD proposal via batch signatures. No on-chain proposal needed
   * on the parent.
   *
   * The proposal's `childAccount` must equal this contract's address and
   * `data` must equal Poseidon.hash(ownersCommitment, threshold, numOwners).
   */
  @method async setupChild(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field,
    initialOwners: SetupOwnersInput,
    proposal: TransactionProposal,
    sigs: SignatureInputs,
  ) {
    const parentAddress = proposal.guardAddress;
    parentAddress.equals(PublicKey.empty()).assertFalse('Parent address required');

    // Verify proposal is CREATE_CHILD targeting this address
    proposal.txType.assertEquals(TxType.CREATE_CHILD, 'Not a create child tx');
    proposal.destination.assertEquals(Destination.REMOTE, 'Not a remote execution proposal');
    proposal.childAccount.assertEquals(this.address);

    // Verify proposal data matches child config
    const childConfigHash = Poseidon.hash([ownersCommitment, threshold, numOwners]);
    proposal.data.assertEquals(childConfigHash, 'Child config mismatch');

    const proposalHash = this.verifyParentBatchSig(proposal, parentAddress, sigs);

    this.initializeState(ownersCommitment, threshold, numOwners, networkId, parentAddress, initialOwners);

    this.policyEnabled.set(Field(1));

    this.emitEvent('createChild', {
      proposalHash,
      childAddress: this.address,
      parentAddress,
      ownersCommitment,
      threshold,
      numOwners,
    });
  }

  /**
   * Proposes a new transaction and records the proposer's first approval.
   */
  @method async propose(
    proposal: TransactionProposal,
    ownerWitness: OwnerWitness,
    proposer: PublicKey,
    signature: Signature,
    voteNullifierWitness: MerkleMapWitness,
    approvalWitness: MerkleMapWitness
  ) {
    // --- propose logic ---
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();
    this.assertOwnerMembership(proposer, ownerWitness, ownersCommitment);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalDestinationAndChildAccount(proposal);

    const proposalHash = proposal.hash();

    // --- approval logic ---
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
      tokenId: proposal.tokenId,
      txType: proposal.txType,
      data: proposal.data,
      uid: proposal.uid,
      configNonce: proposal.configNonce,
      expiryBlock: proposal.expiryBlock,
      networkId: proposal.networkId,
      guardAddress: proposal.guardAddress,
      destination: proposal.destination,
      childAccount: proposal.childAccount,
    });

    this.emitTransferEvents(proposal, proposalHash);

    this.emitEvent('approval', {
      proposalHash,
      approver: proposer,
      approvalCount: PROPOSED_MARKER.add(1),
    });
  }

  /** Verifies and records a non-proposer owner approval for an existing proposal. */
  @method async approveProposal(
    proposal: TransactionProposal,
    signature: Signature,
    approver: PublicKey,
    ownerWitness: OwnerWitness,
    approvalWitness: MerkleMapWitness,
    currentApprovalCount: Field,
    voteNullifierWitness: MerkleMapWitness
  ) {
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();
    this.assertOwnerMembership(approver, ownerWitness, ownersCommitment);
    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalDestinationAndChildAccount(proposal);

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
    this.assertPolicyEnabledIfChild();
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.TRANSFER, 'Not a transfer tx');
    this.assertLocalProposal(proposal);

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal);

    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const { threshold } = this.getGovernanceState();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    this.executeTransfers(proposal, proposalHash);

    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });
  }

  @method async executeTransferBatchSig(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    sigs: SignatureInputs
  ) {
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();
    proposal.txType.assertEquals(TxType.TRANSFER, 'Not a transfer tx');
    this.assertLocalProposal(proposal);
    this.assertProposalConfigNetworkAndGuard(proposal);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    // Verify that this proposal has not been initialized, and has not been executed (EXECUTED_MARKER != 0)
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch')

    const { threshold } = this.getGovernanceState();
    // Bypass the normal threshold verification (skip PROPOSED_MARKER handling)
    verificationRes.approvalCount.assertGreaterThanOrEqual(threshold, 'Insufficient approvals');

    // Execute transfers
    this.executeTransfers(proposal, proposalHash);

    // Mark as executed
    this.markExecuted(approvalWitness);

    this.emitEvent('executionBatch', {
      proposalHash,
      txType: proposal.txType,
      approverChain: verificationRes.signerChain
    });

  }

  @method async executeOwnerChangeBatchSig(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    sigs: SignatureInputs,
    ownerPubKey: PublicKey,
    ownerWitness: OwnerWitness,
    insertAfter: PublicKeyOption,
  ) {
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();

    // Must be ADD_OWNER or REMOVE_OWNER
    const isAdd = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemove = proposal.txType.equals(TxType.REMOVE_OWNER);
    isAdd.or(isRemove).assertTrue('Not an owner change tx');
    this.assertLocalProposal(proposal);

    this.assertProposalConfigNetworkAndGuard(proposal);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const { threshold, numOwners } = this.getGovernanceState();
    verificationRes.approvalCount.assertGreaterThanOrEqual(threshold, 'Insufficient approvals');

    // Verify proposal data matches owner
    const ownerHash = ownerKey(ownerPubKey);
    proposal.data.assertEquals(ownerHash, 'Data does not match owner');

    // both functions check if owners exists or does not exist in the list (remove/add)
    const [afterAddComm, addIsValid] = addOwnerToCommitment(ownersCommitment, ownerPubKey,
      ownerWitness, insertAfter);
    const [afterRemoveComm, remIsValid] = removeOwnerFromCommitment(ownersCommitment, ownerPubKey, ownerWitness);

    const newNumOwners = numOwners.add(isAdd.toField()).sub(isRemove.toField());
    newNumOwners.assertGreaterThanOrEqual(
      threshold,
      'Cannot remove: would go below threshold'
    );

    newNumOwners.assertLessThanOrEqual(MAX_OWNERS, `Cannot have more than ${MAX_OWNERS.toString()} owners.`)

    Provable.if(isRemove, remIsValid, addIsValid).assertTrue('Owner change not valid');
    this.ownersCommitment.set(Provable.if(isRemove, afterRemoveComm, afterAddComm));
    this.setGovernanceState(threshold, newNumOwners);

    // Mark as executed
    this.markExecuted(approvalWitness);

    // Increment config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('executionBatch', {
      proposalHash,
      txType: proposal.txType,
      approverChain: verificationRes.signerChain,
    });

    this.emitEvent('ownerChangeBatch', {
      proposalHash,
      owner: ownerPubKey,
      added: isAdd.toField(),
      newNumOwners,
      configNonce: currentConfigNonce.add(1),
      approverChain: verificationRes.signerChain,
    });
  }

  @method async executeThresholdChangeBatchSig(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    sigs: SignatureInputs,
    newThreshold: Field,
  ) {
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(
      TxType.CHANGE_THRESHOLD,
      'Not a threshold change tx'
    );
    this.assertLocalProposal(proposal);

    this.assertProposalConfigNetworkAndGuard(proposal);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const { threshold: currentThreshold, numOwners } = this.getGovernanceState();
    verificationRes.approvalCount.assertGreaterThanOrEqual(currentThreshold, 'Insufficient approvals');

    // Verify data matches new threshold
    proposal.data.assertEquals(
      newThreshold,
      'Data does not match new threshold'
    );

    // Validate new threshold
    newThreshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      newThreshold,
      'Threshold cannot exceed owner count'
    );

    this.setGovernanceState(newThreshold, numOwners);

    // Mark as executed
    this.markExecuted(approvalWitness);

    // Increment config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('executionBatch', {
      proposalHash,
      txType: proposal.txType,
      approverChain: verificationRes.signerChain,
    });

    this.emitEvent('thresholdChangeBatch', {
      proposalHash,
      oldThreshold: currentThreshold,
      newThreshold,
      configNonce: currentConfigNonce.add(1),
      approverChain: verificationRes.signerChain,
    });
  }

  @method async executeDelegateBatchSig(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    sigs: SignatureInputs,
    delegate: PublicKey,
  ) {
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(
      TxType.SET_DELEGATE,
      'Not a delegate tx'
    );
    this.assertLocalProposal(proposal);

    this.assertProposalConfigNetworkAndGuard(proposal);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const { threshold } = this.getGovernanceState();
    verificationRes.approvalCount.assertGreaterThanOrEqual(threshold, 'Insufficient approvals');

    // Un-delegation: data == 0 means delegate to self
    // Delegation: data must match hash of delegate pubkey
    const isUndelegate = proposal.data.equals(Field(0));
    const delegateHash = ownerKey(delegate);
    isUndelegate
      .or(proposal.data.equals(delegateHash))
      .assertTrue('Data does not match delegate');

    const targetDelegate = Provable.if(isUndelegate, PublicKey, this.address, delegate);
    this.account.delegate.set(targetDelegate);

    // Mark as executed
    this.markExecuted(approvalWitness);

    this.emitEvent('executionBatch', {
      proposalHash,
      txType: proposal.txType,
      approverChain: verificationRes.signerChain,
    });

    this.emitEvent('delegateBatch', {
      proposalHash,
      delegate: targetDelegate,
      approverChain: verificationRes.signerChain,
    });
  }

  /** Executes owner add/remove proposals and updates config nonce after success. */
  @method async executeOwnerChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    ownerPubKey: PublicKey,
    ownerWitness: OwnerWitness,
    insertAfter: PublicKeyOption,
  ) {
    this.assertPolicyEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();

    const isAdd = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemove = proposal.txType.equals(TxType.REMOVE_OWNER);
    isAdd.or(isRemove).assertTrue('Not an owner change tx');
    this.assertLocalProposal(proposal);

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const { threshold, numOwners } = this.getGovernanceState();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    const ownerHash = ownerKey(ownerPubKey);
    proposal.data.assertEquals(ownerHash, 'Data does not match owner');

    // both functions check if owners exists or does not exist in the list (remove/add)
    const [afterAddComm, addIsValid] = addOwnerToCommitment(ownersCommitment, ownerPubKey,
      ownerWitness, insertAfter);
    const [afterRemoveComm, remIsValid] = removeOwnerFromCommitment(ownersCommitment, ownerPubKey, ownerWitness);

    const newNumOwners = numOwners.add(isAdd.toField()).sub(isRemove.toField());
    newNumOwners.assertGreaterThanOrEqual(
      threshold,
      'Cannot remove: would go below threshold'
    );

    newNumOwners.assertLessThanOrEqual(MAX_OWNERS, `Cannot have more than ${MAX_OWNERS.toString()} owners.`)

    // depending on change type, check corresponding operation was successful
    Provable.if(isRemove, remIsValid, addIsValid).assertTrue('Owner change not valid');
    // select corresponding new commitment to update state
    this.ownersCommitment.set(Provable.if(isRemove, afterRemoveComm, afterAddComm));
    this.setGovernanceState(threshold, newNumOwners);

    this.markExecuted(approvalWitness);

    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });

    this.emitEvent('ownerChange', {
      proposalHash,
      owner: ownerPubKey,
      added: isAdd.toField(),
      newNumOwners,
      configNonce: currentConfigNonce.add(1),
    });
  }

  /** Executes threshold change proposals and bumps config nonce on success. */
  @method async executeThresholdChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    newThreshold: Field
  ) {
    this.assertPolicyEnabledIfChild();
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(
      TxType.CHANGE_THRESHOLD,
      'Not a threshold change tx'
    );
    this.assertLocalProposal(proposal);

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const { threshold: currentThreshold, numOwners } = this.getGovernanceState();
    this.assertThresholdSatisfied(approvalCount, currentThreshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    proposal.data.assertEquals(
      newThreshold,
      'Data does not match new threshold'
    );

    newThreshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      newThreshold,
      'Threshold cannot exceed owner count'
    );

    this.setGovernanceState(newThreshold, numOwners);

    this.markExecuted(approvalWitness);

    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    this.configNonce.set(currentConfigNonce.add(1));

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });

    this.emitEvent('thresholdChange', {
      proposalHash,
      oldThreshold: currentThreshold,
      newThreshold,
      configNonce: currentConfigNonce.add(1),
    });
  }

  /** Executes delegate/undelegate proposals once threshold and data checks pass. */
  @method async executeDelegate(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    delegate: PublicKey
  ) {
    this.assertPolicyEnabledIfChild();
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(
      TxType.SET_DELEGATE,
      'Not a delegate tx'
    );
    this.assertLocalProposal(proposal);

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const { threshold } = this.getGovernanceState();
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
      txType: proposal.txType,
    });

    this.emitEvent('delegate', {
      proposalHash,
      delegate: targetDelegate,
    });
  }

  // -- Child Lifecycle Methods ------------------------------------------------

  /**
   * Parent allocates MINA to child accounts. Uses receivers array as (childAddress, amount) pairs.
   * 
   * Note: Should be called on the parent account.
   */
  @method async allocateChildren(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    sigs: SignatureInputs
  ) {
    const ownersCommitment = this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.ALLOCATE_CHILD, 'Not an allocate child tx');
    this.assertLocalProposal(proposal);
    this.assertProposalConfigNetworkAndGuard(proposal);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const { threshold } = this.getGovernanceState();
    verificationRes.approvalCount.assertGreaterThanOrEqual(threshold, 'Insufficient approvals');

    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.send({ to: r.address, amount: effectiveAmount });
      this.emitEvent('allocateChild', {
        proposalHash,
        childAddress: r.address,
        amount: effectiveAmount,
      });
    }

    this.markExecuted(approvalWitness);

    this.emitEvent('executionBatch', {
      proposalHash,
      txType: proposal.txType,
      approverChain: verificationRes.signerChain,
    });
  }

  /**
   * Child reclaims MINA to parent, authorized by parent batch-sigs.
   * 
   * Note: Should be called on the child contract.
   */
  @method async reclaimToParent(
    proposal: TransactionProposal,
    sigs: SignatureInputs,
    childExecutionWitness: MerkleMapWitness,
    amount: UInt64
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.RECLAIM_CHILD, 'Not a reclaim child tx');

    const parentAddress = this.parent.getAndRequireEquals();
    this.assertCurrAccountIsChild(parentAddress);
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentBatchSig(proposal, parentAddress, sigs);

    this.assertChildExecutionWitnessValue(proposalHash, childExecutionWitness, Field(0));

    proposal.data.assertEquals(amount.value, 'Data does not match reclaim amount');

    this.send({ to: parentAddress, amount });

    this.markChildExecuted(childExecutionWitness);

    this.emitEvent('reclaimChild', {
      proposalHash,
      amount,
    });
  }

  /**
   * Destroys child: sends full balance to parent and freezes the account.
   * 
   * Note: Should be called on the child contract.
   */
  @method async destroy(
    proposal: TransactionProposal,
    sigs: SignatureInputs,
    childExecutionWitness: MerkleMapWitness
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.DESTROY_CHILD, 'Not a destroy child tx');

    const parentAddress = this.parent.getAndRequireEquals();
    this.assertCurrAccountIsChild(parentAddress);
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentBatchSig(proposal, parentAddress, sigs);

    this.assertChildExecutionWitnessValue(proposalHash, childExecutionWitness, Field(0));

    const balance = this.account.balance.getAndRequireEquals();
    this.send({ to: parentAddress, amount: balance });

    this.markChildExecuted(childExecutionWitness);

    this.policyEnabled.set(Field(0));

    this.emitEvent('destroyChild', {
      proposalHash,
      reclaimedAmount: balance,
    });

    this.emitEvent('togglePolicy', {
      proposalHash,
      enabled: Field(0),
    });
  }

  /**
   * Toggles independent policy on child, authorized by parent batch-sigs.
   * 
   * Note: Should be called on the child contract.
   */
  @method async togglePolicy(
    proposal: TransactionProposal,
    sigs: SignatureInputs,
    childExecutionWitness: MerkleMapWitness,
    enabled: Field
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.TOGGLE_POLICY, 'Not a toggle policy tx');

    const parentAddress = this.parent.getAndRequireEquals();
    this.assertCurrAccountIsChild(parentAddress);
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentBatchSig(proposal, parentAddress, sigs);

    this.assertChildExecutionWitnessValue(proposalHash, childExecutionWitness, Field(0));

    proposal.data.assertEquals(enabled, 'Data does not match enabled flag');
    enabled.equals(Field(0)).or(enabled.equals(Field(1))).assertTrue('Enabled must be 0 or 1');

    this.policyEnabled.set(enabled);

    this.markChildExecuted(childExecutionWitness);

    this.emitEvent('togglePolicy', {
      proposalHash,
      enabled,
    });
  }
}
