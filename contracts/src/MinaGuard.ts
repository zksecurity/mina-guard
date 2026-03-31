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

import { MAX_OWNERS, MAX_RECEIVERS, PROPOSED_MARKER, EXECUTED_MARKER, EMPTY_MERKLE_MAP_ROOT, TxType } from './constants';

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
}) { }

/** Emitted for each setup owner slot (fixed-size array). */
export class SetupOwnerEvent extends Struct({
  owner: PublicKey,
  index: Field,
}) { }

/**
 * Emitted when a new proposal is created and indexed by proposalHash.
 * Receiver/amount data is emitted separately via ProposalReceiverEvent
 * (one per MAX_RECEIVERS slot) since Mina limits events to 16 field elements.
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
}) { }

/** Emitted once per receiver slot during transfer execution (fixed-size, padded with empties). */
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


  /** Method to initialize the contract. Cannot call twice.
   *
   * IMPORTANT: Assuming an untrusted deployer, a client must compute the expected commitment
   * themselves and cross-check with the one on chain. numOwners as well, for sync.
   *
   * Emits fixed-size owner bootstrap events for indexers.
   */
  @method async setup(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field,
    initialOwners: SetupOwnersInput
  ) {
    // Use requireEquals instead of getAndRequireEquals so deploy+setup can
    // be combined in a single transaction (no account cache read needed).
    this.ownersCommitment.requireEquals(Field(0));

    threshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      threshold,
      'Owners must be >= threshold'
    );
    numOwners.assertLessThanOrEqual(Field(MAX_OWNERS), 'Too many owners');

    this.ownersCommitment.set(ownersCommitment);
    this.threshold.set(threshold);
    this.numOwners.set(numOwners);
    this.approvalRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.voteNullifierRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.networkId.set(networkId);

    this.emitEvent('setup', { ownersCommitment, threshold, numOwners, networkId });

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
    const ownersCommitment = this.getInitializedOwnersCommitment();
    this.assertOwnerMembership(proposer, ownerWitness, ownersCommitment);

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');

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
    });

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
    const ownersCommitment = this.getInitializedOwnersCommitment();
    this.assertOwnerMembership(approver, ownerWitness, ownersCommitment);
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
    this.getInitializedOwnersCommitment();

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

    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.send({ to: r.address, amount: effectiveAmount });
      this.emitEvent('transfer', { proposalHash, receiver: r.address, amount: effectiveAmount });
    }

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

    const ownersCommitment = this.getInitializedOwnersCommitment();
    proposal.txType.assertEquals(TxType.TRANSFER, 'Not a transfer tx');
    this.assertProposalConfigNetworkAndGuard(
      proposal,
      'Config nonce mismatch - governance changed since proposal'
    );

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    // Verify that this proposal has not been initialized, and has not been executed (EXECUTED_MARKER != 0)
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch')

    const threshold = this.threshold.getAndRequireEquals();
    // Bypass the normal threshold verification (skip PROPOSED_MARKER handling)
    verificationRes.approvalCount.assertGreaterThanOrEqual(threshold, 'Insufficient approvals');

    // Execute transfers
    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.send({ to: r.address, amount: effectiveAmount });
      this.emitEvent('transfer', { proposalHash, receiver: r.address, amount: effectiveAmount });
    }

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
    const ownersCommitment = this.getInitializedOwnersCommitment();

    // Must be ADD_OWNER or REMOVE_OWNER
    const isAdd = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemove = proposal.txType.equals(TxType.REMOVE_OWNER);
    isAdd.or(isRemove).assertTrue('Not an owner change tx');

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const threshold = this.threshold.getAndRequireEquals();
    verificationRes.approvalCount.assertGreaterThanOrEqual(threshold, 'Insufficient approvals');

    // Verify proposal data matches owner
    const ownerHash = ownerKey(ownerPubKey);
    proposal.data.assertEquals(ownerHash, 'Data does not match owner');

    const numOwners = this.numOwners.getAndRequireEquals();

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
    this.numOwners.set(newNumOwners);

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
    const ownersCommitment = this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(
      TxType.CHANGE_THRESHOLD,
      'Not a threshold change tx'
    );

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const currentThreshold = this.threshold.getAndRequireEquals();
    verificationRes.approvalCount.assertGreaterThanOrEqual(currentThreshold, 'Insufficient approvals');

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
    const ownersCommitment = this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(
      TxType.SET_DELEGATE,
      'Not a delegate tx'
    );

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');

    const currentCounter = this.proposalCounter.getAndRequireEquals();
    this.proposalCounter.set(currentCounter.add(1));

    this.assertProposalNotExpired(proposal);
    const proposalHash = proposal.hash();

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    const verificationRes = batchVerify(sigs, proposalHash);
    verificationRes.ownerChain.assertEquals(ownersCommitment, 'Owner list mismatch');

    const threshold = this.threshold.getAndRequireEquals();
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
    const ownersCommitment = this.getInitializedOwnersCommitment();

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
    this.numOwners.set(newNumOwners);

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
    this.getInitializedOwnersCommitment();

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
    this.getInitializedOwnersCommitment();

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
      txType: proposal.txType,
    });

    this.emitEvent('delegate', {
      proposalHash,
      delegate: targetDelegate,
    });
  }
}
