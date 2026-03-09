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
  UInt64,
} from 'o1js';

import { ownerKey } from './utils';

import { MAX_OWNERS, PROPOSED_MARKER, EXECUTED_MARKER, EMPTY_MERKLE_MAP_ROOT, TxType } from './constants';

import { addOwnerToCommitment, removeOwnerFromCommitment, assertOwnerMembership, OwnerWitness, PublicKeyOption } from './list-commitment';
import { batchVerify, SignatureInputs } from './batch-verify';

// -- Types -------------------------------------------------------------------

export class TransactionProposal extends Struct({
  to: PublicKey,
  amount: UInt64,
  tokenId: Field,
  txType: Field,
  data: Field,
  uid: Field,
  configNonce: Field,
  expiryBlock: Field,
  networkId: Field,
  guardAddress: PublicKey,
}) {
  hash(): Field {
    return Poseidon.hash([
      ...this.to.toFields(),
      ...this.amount.toFields(),
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

// -- Events ------------------------------------------------------------------

export class ProposalEvent extends Struct({
  proposalHash: Field,
  proposer: PublicKey,
  uid: Field,
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

export class ExecutionBatchEvent extends Struct({
  proposalHash: Field,
  to: PublicKey,
  amount: UInt64,
  txType: Field,
  approverChain: Field,
}) { }

export class OwnerChangeEvent extends Struct({
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
}) { }

export class OwnerChangeBatchEvent extends Struct({
  proposalHash: Field,
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
  approverChain: Field,
}) { }

export class ThresholdChangeEvent extends Struct({
  oldThreshold: Field,
  newThreshold: Field,
}) { }

export class ThresholdChangeBatchEvent extends Struct({
  proposalHash: Field,
  oldThreshold: Field,
  newThreshold: Field,
  approverChain: Field,
}) { }

export class DelegateEvent extends Struct({
  delegate: PublicKey,
}) { }

export class DelegateBatchEvent extends Struct({
  proposalHash: Field,
  delegate: PublicKey,
  approverChain: Field,
}) { }

// -- Contract ----------------------------------------------------------------

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
    proposal: ProposalEvent,
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

  private getInitializedOwnersCommitment(): Field {
    const ownersCommitment = this.ownersCommitment.getAndRequireEquals();
    ownersCommitment.assertNotEquals(Field(0), 'Wallet not initialized');
    return ownersCommitment;
  }

  private assertOwnerMembership(
    owner: PublicKey,
    ownerWitness: OwnerWitness,
    ownersCommitment: Field
  ): void {
    assertOwnerMembership(ownersCommitment, owner, ownerWitness, Bool(true));
  }

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

  private assertProposalNotExpired(proposal: TransactionProposal): void {
    const noExpiry = proposal.expiryBlock.equals(Field(0));
    const blockchainLength = this.network.blockchainLength.getAndRequireEquals();
    const notExpired = blockchainLength.value.lessThanOrEqual(proposal.expiryBlock);
    noExpiry.or(notExpired).assertTrue('Proposal expired');
  }

  private assertNotExecuted(approvalCount: Field): void {
    approvalCount.equals(EXECUTED_MARKER).assertFalse('Proposal already executed');
  }

  private assertProposalExists(approvalCount: Field): void {
    approvalCount.assertGreaterThanOrEqual(PROPOSED_MARKER, 'Proposal not found');
  }

  private assertThresholdSatisfied(approvalCount: Field, threshold: Field): void {
    approvalCount.sub(PROPOSED_MARKER).assertGreaterThanOrEqual(
      threshold,
      'Insufficient approvals'
    );
  }

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

  private markExecuted(approvalWitness: MerkleMapWitness): void {
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(EXECUTED_MARKER);
    this.approvalRoot.set(newApprovalRoot);
  }

  // TODO: verify if we need an additional check here, to avoid front-running
  @method async setup(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field
  ) {
    const currentCommitment = this.ownersCommitment.getAndRequireEquals();
    currentCommitment.assertEquals(Field(0), 'Already initialized');

    threshold.assertGreaterThan(Field(0), 'Threshold must be > 0');
    numOwners.assertGreaterThanOrEqual(
      threshold,
      'Owners must be >= threshold'
    );

    this.ownersCommitment.set(ownersCommitment);
    this.threshold.set(threshold);
    this.numOwners.set(numOwners);
    this.approvalRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.voteNullifierRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.networkId.set(networkId);
  }

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
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, Field(0));

    // PROPOSED_MARKER (1) + 1 approval = 2
    const [newApprovalRoot] = approvalWitness.computeRootAndKey(PROPOSED_MARKER.add(1));
    this.approvalRoot.set(newApprovalRoot);

    this.emitEvent('proposal', {
      proposalHash,
      proposer,
      uid: proposal.uid,
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

    // Ensure the proposal was actually proposed (marker >= 1) and not already executed
    this.assertNotExecuted(currentApprovalCount);
    this.assertProposalExists(currentApprovalCount);

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

    // Verify threshold (approvalCount includes PROPOSED_MARKER offset)
    const threshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, threshold);

    // Verify approval count via witness (keyed by proposalHash)
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    // Execute transfer
    this.send({ to: proposal.to, amount: proposal.amount });

    // Mark as executed
    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      to: proposal.to,
      amount: proposal.amount,
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

    // Execute transfer
    this.send({ to: proposal.to, amount: proposal.amount });

    // Mark as executed
    this.markExecuted(approvalWitness);

    this.emitEvent('executionBatch', {
      proposalHash,
      to: proposal.to,
      amount: proposal.amount,
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

    this.emitEvent('ownerChangeBatch', {
      proposalHash,
      owner: ownerPubKey,
      added: isAdd.toField(),
      newNumOwners,
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

    this.emitEvent('thresholdChangeBatch', {
      proposalHash,
      oldThreshold: currentThreshold,
      newThreshold,
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

    this.emitEvent('delegateBatch', {
      proposalHash,
      delegate: targetDelegate,
      approverChain: verificationRes.signerChain,
    });
  }

  @method async executeOwnerChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    ownerPubKey: PublicKey,
    ownerWitness: OwnerWitness,
    insertAfter: PublicKeyOption,
  ) {
    const ownersCommitment = this.getInitializedOwnersCommitment();

    // Must be ADD_OWNER or REMOVE_OWNER
    const isAdd = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemove = proposal.txType.equals(TxType.REMOVE_OWNER);
    isAdd.or(isRemove).assertTrue('Not an owner change tx');

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal, 'Config nonce mismatch');
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    // Verify threshold (approvalCount includes PROPOSED_MARKER offset)
    const threshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, threshold);

    // Verify approval witness (keyed by proposalHash)
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

    // Verify proposal data matches owner
    const ownerHash = ownerKey(ownerPubKey);
    proposal.data.assertEquals(ownerHash, 'Data does not match owner');

    const numOwners = this.numOwners.getAndRequireEquals();

    // both functions check if owners exists or does not exist in the list (remove/add)
    const [afterAddComm, addIsValid] = addOwnerToCommitment(ownersCommitment, ownerPubKey,
      ownerWitness, insertAfter);
    const [afterRemoveComm, remIsValid] = removeOwnerFromCommitment(ownersCommitment, ownerPubKey, ownerWitness);

    // For REMOVE: ensure numOwners - 1 >= threshold
    // For ADD: this check trivially passes since numOwners + 1 >= threshold
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

    // Mark as executed
    this.markExecuted(approvalWitness);

    // Increment config nonce
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
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

    // Verify threshold (using current, approvalCount includes PROPOSED_MARKER offset)
    const currentThreshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, currentThreshold);

    // Verify approval witness (keyed by proposalHash)
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

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

    // Verify threshold (approvalCount includes PROPOSED_MARKER offset)
    const threshold = this.threshold.getAndRequireEquals();
    this.assertThresholdSatisfied(approvalCount, threshold);

    // Verify approval witness (keyed by proposalHash)
    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);

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
    this.markExecuted(approvalWitness);

    // TODO: re-evaluate whether delegation should invalidate pending proposals (increment configNonce)

    this.emitEvent('delegate', {
      delegate: targetDelegate,
    });
  }
}
