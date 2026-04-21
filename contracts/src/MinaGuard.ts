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
 *
 * `destination` selects LOCAL (executes on the guard that stores the proposal)
 * vs REMOTE (proposed/approved on a parent guard, executed on a specific child).
 * `childAccount` is the target child for REMOTE proposals and must be empty
 * for LOCAL proposals.
 */
export class TransactionProposal extends Struct({
  receivers: ReceiversArray,
  tokenId: Field,
  txType: Field,
  data: Field,
  nonce: Field,
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
      this.nonce,
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
 * Receiver/amount data is emitted via ReceiverEvent (one per MAX_RECEIVERS
 * slot, padded with empties) since Mina limits events to 16 field elements.
 */
export class ProposalEvent extends Struct({
  proposalHash: Field,
  proposer: PublicKey,
  tokenId: Field,
  txType: Field,
  data: Field,
  nonce: Field,
  configNonce: Field,
  expiryBlock: Field,
  networkId: Field,
  guardAddress: PublicKey,
  destination: Field,
  childAccount: PublicKey,
}) { }

/** Emitted once per receiver slot during propose (fixed-size, padded with empties). */
export class ReceiverEvent extends Struct({
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

export class OwnerChangeEvent extends Struct({
  proposalHash: Field,
  owner: PublicKey,
  added: Field,
  newNumOwners: Field,
  configNonce: Field,
}) { }

export class ThresholdChangeEvent extends Struct({
  proposalHash: Field,
  oldThreshold: Field,
  newThreshold: Field,
  configNonce: Field,
}) { }

export class DelegateEvent extends Struct({
  proposalHash: Field,
  delegate: PublicKey,
}) { }

/** Emitted when a child guard successfully runs executeSetupChild. */
export class CreateChildEvent extends Struct({
  proposalHash: Field,
  parentAddress: PublicKey,
}) { }

/**
 * Emitted whenever a child guard sends MINA back to its parent — used by
 * both executeReclaimToParent (partial) and executeDestroy (full balance).
 * The discriminator between the two flows is in the sibling ExecutionEvent's
 * txType (RECLAIM_CHILD vs DESTROY_CHILD).
 */
export class ReclaimChildEvent extends Struct({
  proposalHash: Field,
  parentAddress: PublicKey,
  amount: UInt64,
}) { }

/** Emitted on toggle of a child's independent multisig policy. */
export class EnableChildMultiSigEvent extends Struct({
  proposalHash: Field,
  parentAddress: PublicKey,
  enabled: Field,
}) { }

// -- Contract ----------------------------------------------------------------

/**
 * MinaGuard multisig contract.
 * Stores compact roots and counters on-chain while using witnesses for membership and approvals.
 *
 * A guard can operate either as a root (parent = PublicKey.empty()) or as a
 * child linked to a parent. Child guards authorize lifecycle operations
 * (reclaim, destroy, enable/disable policy) by reading the parent's on-chain
 * approval state as AccountUpdate preconditions and verifying a Merkle
 * witness proving the parent accumulated enough approvals.
 */
export class MinaGuard extends SmartContract {
  @state(Field) ownersCommitment = State<Field>();
  @state(Field) threshold = State<Field>();
  @state(Field) numOwners = State<Field>();
  @state(Field) nonce = State<Field>();
  @state(Field) voteNullifierRoot = State<Field>();
  @state(Field) approvalRoot = State<Field>();
  @state(Field) configNonce = State<Field>();
  @state(Field) networkId = State<Field>();
  @state(PublicKey) parent = State<PublicKey>();
  @state(Field) parentNonce = State<Field>();
  @state(Field) childExecutionRoot = State<Field>();
  @state(Field) childMultiSigEnabled = State<Field>();

  events = {
    deployed: DeployEvent,
    setup: SetupEvent,
    setupOwner: SetupOwnerEvent,
    proposal: ProposalEvent,
    receiver: ReceiverEvent,
    approval: ApprovalEvent,
    execution: ExecutionEvent,
    ownerChange: OwnerChangeEvent,
    thresholdChange: ThresholdChangeEvent,
    delegate: DelegateEvent,
    createChild: CreateChildEvent,
    reclaimChild: ReclaimChildEvent,
    enableChildMultiSig: EnableChildMultiSigEvent,
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

  // -- Shared validation helpers ---------------------------------------------

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

  /** Generic Merkle-map witness check. */
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

  private getNonceState(): Field {
    return this.nonce.getAndRequireEquals();
  }

  private getParentNonceState(): Field {
    return this.parentNonce.getAndRequireEquals();
  }

  /**
   * Root guards (parent == empty) always pass. Child guards must have
   * childMultiSigEnabled == 1 to run multisig ops (propose / approve /
   * execute*). Lifecycle methods (executeReclaimToParent / executeDestroy /
   * executeEnableChildMultiSig) are intentionally exempt so a frozen child
   * can still be controlled by its parent.
   */
  private assertChildMultiSigEnabledIfChild(): void {
    const parent = this.parent.getAndRequireEquals();
    const isChild = parent.equals(PublicKey.empty()).not();
    const enabled = this.childMultiSigEnabled.getAndRequireEquals();
    isChild.not().or(enabled.equals(Field(1))).assertTrue('Child multi-sig disabled');
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
    proposal.childAccount
      .equals(this.address)
      .assertTrue('Proposal not for this child');
  }

  private assertCurrAccountIsChild(parent: PublicKey): void {
    parent.equals(PublicKey.empty()).assertFalse('Not a child account');
  }

  /** Low-level config/network/guard check against explicit values. */
  private assertValidProposalConfigNetworkAndGuard(
    proposal: TransactionProposal,
    configNonce: Field,
    networkId: Field,
    guardAddress: PublicKey,
  ): void {
    proposal.configNonce.assertEquals(configNonce, 'Config nonce mismatch - governance changed since proposal');
    proposal.networkId.assertEquals(networkId, 'Network ID mismatch');
    proposal.guardAddress.equals(guardAddress).assertTrue('Guard address mismatch');
  }

  /** Validates proposal binding to this contract's current state. */
  private assertProposalConfigNetworkAndGuard(
    proposal: TransactionProposal,
  ): void {
    const currentConfigNonce = this.configNonce.getAndRequireEquals();
    const currentNetworkId = this.networkId.getAndRequireEquals();
    this.assertValidProposalConfigNetworkAndGuard(
      proposal,
      currentConfigNonce,
      currentNetworkId,
      this.address,
    );
  }

  /**
   * Checks:
   * 1. destination is LOCAL or REMOTE.
   * 2. LOCAL proposals must not target a child account.
   * 3. REMOTE proposals must target a non-empty child account.
   * 4. REMOTE proposals can only be proposed/approved on a root (parent == empty).
   */
  private assertProposalDestinationAndChildAccount(proposal: TransactionProposal): void {
    const isDestinationLocal = proposal.destination.equals(Destination.LOCAL);
    const isDestinationRemote = proposal.destination.equals(Destination.REMOTE);
    isDestinationLocal.or(isDestinationRemote).assertTrue('Invalid destination value');

    const childAccountEmpty = proposal.childAccount.equals(PublicKey.empty());
    isDestinationRemote
      .or(childAccountEmpty)
      .assertTrue('Local destination proposals cannot target child accounts');

    isDestinationLocal
      .or(childAccountEmpty.not())
      .assertTrue('Remote destination proposals must target a specific child account');

    const isRoot = this.parent.getAndRequireEquals().equals(PublicKey.empty());
    isDestinationLocal
      .or(isRoot)
      .assertTrue('Remote destination proposals must be proposed on a root guard');
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

  private assertFreshProposalNonce(proposal: TransactionProposal): void {
    const isLocal = proposal.destination.equals(Destination.LOCAL);
    const isCreateChild = proposal.txType.equals(TxType.CREATE_CHILD);
    const isRemoteNonCreate = proposal.destination
      .equals(Destination.REMOTE)
      .and(isCreateChild.not());
    const isRemoteCreate = proposal.destination
      .equals(Destination.REMOTE)
      .and(isCreateChild);

    const localNonce = this.getNonceState();
    const nonceAuthority = Provable.if(
      isRemoteNonCreate,
      PublicKey,
      proposal.childAccount,
      this.address,
    );
    const childGuard = new MinaGuard(nonceAuthority);
    const childOwnersCommitment = childGuard.ownersCommitment.getAndRequireEquals();
    const childParent = childGuard.parent.getAndRequireEquals();
    const childParentNonce = childGuard.parentNonce.getAndRequireEquals();

    isRemoteNonCreate
      .not()
      .or(childOwnersCommitment.equals(Field(0)).not())
      .assertTrue('Target child not initialized');
    isRemoteNonCreate
      .not()
      .or(childParent.equals(this.address))
      .assertTrue('Target child not bound to this parent');

    isLocal
      .and(proposal.nonce.greaterThan(localNonce))
      .or(isRemoteNonCreate.and(proposal.nonce.greaterThan(childParentNonce)))
      .or(isRemoteCreate.and(proposal.nonce.equals(Field(0))))
      .assertTrue('Proposal nonce stale');
  }

  private assertAndIncrementLocalNonce(proposal: TransactionProposal): void {
    const currentNonce = this.getNonceState();
    const nextNonce = currentNonce.add(1);
    proposal.nonce.assertEquals(nextNonce, 'Invalid proposal nonce');
    this.nonce.set(nextNonce);
  }

  private assertAndIncrementParentNonce(proposal: TransactionProposal): void {
    const currentParentNonce = this.getParentNonceState();
    const nextParentNonce = currentParentNonce.add(1);
    proposal.nonce.assertEquals(nextParentNonce, 'Invalid parent proposal nonce');
    this.parentNonce.set(nextParentNonce);
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

  /** Returns true iff the proposal carries at most one receiver (slots 1..N-1 empty). */
  private atMostOneReceiver(proposal: TransactionProposal): Bool {
    let ok = Bool(true);
    for (let i = 1; i < MAX_RECEIVERS; i++) {
      const slotEmpty = proposal.receivers[i].address.equals(PublicKey.empty());
      ok = ok.and(slotEmpty);
    }
    return ok;
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

  /** Verifies the child's execution witness proves a proposal hasn't been
   *  applied to this child yet (or has been, for replay checks). */
  private assertChildExecutionWitnessValue(
    proposalHash: Field,
    childExecutionWitness: MerkleMapWitness,
    expectedValue: Field,
  ): void {
    const root = this.childExecutionRoot.getAndRequireEquals();
    this.assertMerkleWitnessValue(
      root,
      proposalHash,
      childExecutionWitness,
      expectedValue,
      'Child execution root mismatch',
      'Child execution key mismatch',
    );
  }

  /** Writes EXECUTED_MARKER to the childExecutionRoot at proposalHash. */
  private markChildExecuted(childExecutionWitness: MerkleMapWitness): void {
    const [newRoot] = childExecutionWitness.computeRootAndKey(EXECUTED_MARKER);
    this.childExecutionRoot.set(newRoot);
  }

  private assertParentApprovalState(
    proposal: TransactionProposal,
    parentAddress: PublicKey,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
  ): Field {
    const parentGuard = new MinaGuard(parentAddress);
    const parentOwnersCommitment = parentGuard.ownersCommitment.getAndRequireEquals();
    parentOwnersCommitment.assertNotEquals(Field(0), 'Parent not initialized');

    const parentConfigNonce = parentGuard.configNonce.getAndRequireEquals();
    const parentNetworkId = parentGuard.networkId.getAndRequireEquals();
    const parentApprovalRoot = parentGuard.approvalRoot.getAndRequireEquals();
    const parentThreshold = parentGuard.threshold.getAndRequireEquals();

    this.assertValidProposalConfigNetworkAndGuard(
      proposal,
      parentConfigNonce,
      parentNetworkId,
      parentAddress,
    );
    this.assertProposalNotExpired(proposal);

    const proposalHash = proposal.hash();
    this.assertMerkleWitnessValue(
      parentApprovalRoot,
      proposalHash,
      parentApprovalWitness,
      parentApprovalCount,
      'Parent approval root mismatch',
      'Parent approval key mismatch',
    );

    this.assertNotExecuted(parentApprovalCount);
    this.assertProposalExists(parentApprovalCount);
    this.assertThresholdSatisfied(parentApprovalCount, parentThreshold);

    return proposalHash;
  }

  private verifyParentApproval(
    proposal: TransactionProposal,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
  ): Field {
    const parentAddress = this.parent.getAndRequireEquals();
    this.assertCurrAccountIsChild(parentAddress);
    return this.assertParentApprovalState(
      proposal,
      parentAddress,
      parentApprovalWitness,
      parentApprovalCount,
    );
  }

  /** Emits a receiver event per receiver slot (padded with empties). */
  private emitReceiversEvent(proposal: TransactionProposal, proposalHash: Field): void {
    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.emitEvent('receiver', { proposalHash, receiver: r.address, amount: effectiveAmount });
    }
  }

  /** Sends MINA to each receiver slot. */
  private executeTransfers(proposal: TransactionProposal): void {
    for (let i = 0; i < MAX_RECEIVERS; i++) {
      const r = proposal.receivers[i];
      const isEmpty = r.address.equals(PublicKey.empty());
      const effectiveRecipient = Provable.if(isEmpty, PublicKey, this.address, r.address);
      const effectiveAmount = Provable.if(isEmpty, UInt64, UInt64.from(0), r.amount);
      this.send({ to: effectiveRecipient, amount: effectiveAmount });
    }
  }

  /** Shared initialization: validates config, sets all state, emits setup + owner events. */
  private initializeState(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    networkId: Field,
    parent: PublicKey,
    nonce: Field,
    parentNonce: Field,
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
    this.nonce.set(nonce);
    this.approvalRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.voteNullifierRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.networkId.set(networkId);
    this.parent.set(parent);
    this.parentNonce.set(parentNonce);
    this.childExecutionRoot.set(EMPTY_MERKLE_MAP_ROOT);
    this.childMultiSigEnabled.set(Field(1));

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

  // -- Methods ---------------------------------------------------------------

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
    this.initializeState(
      ownersCommitment,
      threshold,
      numOwners,
      networkId,
      PublicKey.empty(),
      Field(0),
      Field(0),
      initialOwners,
    );
  }

  /**
   * Initializes a child guard linked to a parent.
   *
   * The parent must have a CREATE_CHILD proposal approved to threshold.
   * Reads the parent's on-chain state as AccountUpdate preconditions and
   * verifies the approval witness. Idempotency is guarded by the
   * `ownersCommitment == 0` check inside `initializeState`.
   *
   * ⚠️ DEPLOY-TIME RACE — callers MUST batch this call into the same Mina
   * transaction as the child's `deploy()`. After `deploy()` lands on-chain,
   * the child sits with `ownersCommitment == 0` and anyone in the mempool
   * can call `executeSetupChild` with a proposal bound to an attacker-
   * controlled "parent" address, permanently binding the child to a hostile
   * parent. Keeping deploy + executeSetupChild in a single tx eliminates
   * that mempool window. See `deployAndSetupChildGuard` in
   * `tests/test-helpers.ts` for the safe pattern.
   */
  @method async executeSetupChild(
    ownersCommitment: Field,
    threshold: Field,
    numOwners: Field,
    initialOwners: SetupOwnersInput,
    proposal: TransactionProposal,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
  ) {
    const parentAddress = proposal.guardAddress;
    parentAddress.equals(PublicKey.empty()).assertFalse('Parent address required');

    // Bind proposal to the CREATE_CHILD txType + this child's address + this child's config.
    proposal.txType.assertEquals(TxType.CREATE_CHILD, 'Not a create child tx');
    proposal.destination.assertEquals(Destination.REMOTE, 'Not a remote execution proposal');
    proposal.childAccount.equals(this.address).assertTrue('Proposal not for this child');
    proposal.nonce.assertEquals(Field(0), 'Create child proposal nonce must be 0');

    const childConfigHash = Poseidon.hash([ownersCommitment, threshold, numOwners]);
    proposal.data.assertEquals(childConfigHash, 'Child config mismatch');

    // this.parent isn't persisted yet, so call the shared helper directly
    // with the proposal's guardAddress as the authority. The helper pins the
    // parent's networkId as a precondition, so proposal.networkId is the
    // parent-approved value — use it as the child's networkId instead of an
    // attacker-supplied method argument.
    const proposalHash = this.assertParentApprovalState(
      proposal,
      parentAddress,
      parentApprovalWitness,
      parentApprovalCount,
    );

    this.initializeState(
      ownersCommitment,
      threshold,
      numOwners,
      proposal.networkId,
      parentAddress,
      Field(1),
      Field(1),
      initialOwners,
    );

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });

    this.emitEvent('createChild', {
      proposalHash,
      parentAddress,
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
    this.assertChildMultiSigEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();
    this.assertOwnerMembership(proposer, ownerWitness, ownersCommitment);

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalDestinationAndChildAccount(proposal);
    this.assertFreshProposalNonce(proposal);

    // Only known txTypes are acceptable.
    const isTransfer = proposal.txType.equals(TxType.TRANSFER);
    const isChangeThreshold = proposal.txType.equals(TxType.CHANGE_THRESHOLD);
    const isAddOwner = proposal.txType.equals(TxType.ADD_OWNER);
    const isRemoveOwner = proposal.txType.equals(TxType.REMOVE_OWNER);
    const isSetDelegate = proposal.txType.equals(TxType.SET_DELEGATE);
    const isCreateChild = proposal.txType.equals(TxType.CREATE_CHILD);
    const isAllocateChild = proposal.txType.equals(TxType.ALLOCATE_CHILD);
    const isReclaimChild = proposal.txType.equals(TxType.RECLAIM_CHILD);
    const isDestroyChild = proposal.txType.equals(TxType.DESTROY_CHILD);
    const isEnableChildMultiSig = proposal.txType.equals(TxType.ENABLE_CHILD_MULTI_SIG);
    const isNoop = proposal.txType.equals(TxType.NOOP);

    isTransfer
      .or(isChangeThreshold)
      .or(isAddOwner)
      .or(isRemoveOwner)
      .or(isSetDelegate)
      .or(isCreateChild)
      .or(isAllocateChild)
      .or(isReclaimChild)
      .or(isDestroyChild)
      .or(isEnableChildMultiSig)
      .or(isNoop)
      .assertTrue('Unknown txType');

    /*
    * Receivers are used:
    * - For recipients of transfers (MAX_RECEIVERS allowed, meaning batch transfer)
    * - For the owner to-be-added/to-be-removed (only index 0 is allowed to be non-empty)
    * - For delegate, (1..=N-1) must be empty, index 0 is either delegate addr or empty for undelegate
    * - For threshold change, all must be empty
    */

    const slot0Empty = proposal.receivers[0].address.equals(PublicKey.empty());

    // Rule 1: ADD_OWNER / REMOVE_OWNER require non-empty slot 0
    const needsPubKey = isAddOwner.or(isRemoveOwner);
    needsPubKey.and(slot0Empty).assertFalse('addOwner/removeOwner requires target pubkey in receivers[0]');

    // Rule 2: CHANGE_THRESHOLD and NOOP require empty slot 0
    isChangeThreshold.or(isNoop).and(slot0Empty.not())
      .assertFalse('changeThreshold/noop must have empty receivers[0]');

    // Rule 3: Only transfer-like txTypes (TRANSFER, ALLOCATE_CHILD) may use
    // multiple receiver slots. Everything else is limited to at most one.
    const isTransferLike = isTransfer.or(isAllocateChild);
    isTransferLike.or(this.atMostOneReceiver(proposal))
      .assertTrue('Non-transfer proposal has extra receivers');

    // Rule 4: `data` must be 0 except for txTypes that use it:
    //   CHANGE_THRESHOLD (new threshold), CREATE_CHILD (child config hash),
    //   RECLAIM_CHILD (amount), ENABLE_CHILD_MULTI_SIG (flag).
    const allowsData = isChangeThreshold
      .or(isCreateChild)
      .or(isReclaimChild)
      .or(isEnableChildMultiSig);
    allowsData.or(proposal.data.equals(Field(0)))
      .assertTrue('data must be zero for this txType');

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
      nonce: proposal.nonce,
      configNonce: proposal.configNonce,
      expiryBlock: proposal.expiryBlock,
      networkId: proposal.networkId,
      guardAddress: proposal.guardAddress,
      destination: proposal.destination,
      childAccount: proposal.childAccount,
    });

    this.emitReceiversEvent(proposal, proposalHash);

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
    this.assertChildMultiSigEnabledIfChild();
    const ownersCommitment = this.getInitializedOwnersCommitment();
    this.assertOwnerMembership(approver, ownerWitness, ownersCommitment);
    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalDestinationAndChildAccount(proposal);
    this.assertFreshProposalNonce(proposal);

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
    this.assertChildMultiSigEnabledIfChild();
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
    this.assertAndIncrementLocalNonce(proposal);

    this.executeTransfers(proposal);

    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });
  }

  /** Executes noop proposals — runs all standard checks, burns the nonce,
   *  and emits ExecutionEvent without any side effect. Used by the delete flow. */
  @method async executeNoop(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field
  ) {
    this.assertChildMultiSigEnabledIfChild();
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.NOOP, 'Not a noop tx');
    this.assertLocalProposal(proposal);

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const { threshold } = this.getGovernanceState();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);
    this.assertAndIncrementLocalNonce(proposal);

    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });
  }

  /** Executes a REMOTE noop proposal on a child guard — burns the child's
   *  parentNonce slot so any competing remote proposal at the same nonce is
   *  invalidated. No balance or state change beyond the nonce advance. */
  @method async executeRemoteNoop(
    proposal: TransactionProposal,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
    childExecutionWitness: MerkleMapWitness,
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.NOOP, 'Not a noop tx');
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentApproval(
      proposal,
      parentApprovalWitness,
      parentApprovalCount,
    );

    this.assertChildExecutionWitnessValue(
      proposalHash,
      childExecutionWitness,
      Field(0),
    );
    this.assertAndIncrementParentNonce(proposal);

    this.markChildExecuted(childExecutionWitness);

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });
  }

  @method async executeAllocateToChildren(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
  ) {
    this.assertChildMultiSigEnabledIfChild();
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.ALLOCATE_CHILD, 'Not an allocate child tx');
    this.assertLocalProposal(proposal);

    const proposalHash = proposal.hash();

    this.assertProposalConfigNetworkAndGuard(proposal);
    this.assertProposalNotExpired(proposal);
    this.assertNotExecuted(approvalCount);
    this.assertProposalExists(approvalCount);

    const { threshold } = this.getGovernanceState();
    this.assertThresholdSatisfied(approvalCount, threshold);

    this.assertApprovalWitnessValue(proposalHash, approvalWitness, approvalCount);
    this.assertAndIncrementLocalNonce(proposal);

    this.executeTransfers(proposal);

    this.markExecuted(approvalWitness);

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });
  }

  /** Executes owner add/remove proposals and updates config nonce after success. */
  @method async executeOwnerChange(
    proposal: TransactionProposal,
    approvalWitness: MerkleMapWitness,
    approvalCount: Field,
    ownerWitness: OwnerWitness,
    insertAfter: PublicKeyOption,
  ) {
    this.assertChildMultiSigEnabledIfChild();
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
    this.assertAndIncrementLocalNonce(proposal);

    const ownerPubKey = proposal.receivers[0].address;

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
    this.assertChildMultiSigEnabledIfChild();
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
    this.assertAndIncrementLocalNonce(proposal);

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
  ) {
    this.assertChildMultiSigEnabledIfChild();
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
    this.assertAndIncrementLocalNonce(proposal);

    const isUndelegate = proposal.receivers[0].address.equals(PublicKey.empty());

    const targetDelegate = Provable.if(isUndelegate, PublicKey, this.address, proposal.receivers[0].address);
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

  // -- Child Lifecycle Methods (REMOTE proposals, run on the child) ---------

  /**
   * Child reclaims a specified amount of MINA to its parent.
   *
   * The RECLAIM_CHILD proposal is proposed and approved on the parent.
   * The child reads the parent's approval state as preconditions and
   * verifies the approval witness, then sends the funds.
   */
  @method async executeReclaimToParent(
    proposal: TransactionProposal,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
    childExecutionWitness: MerkleMapWitness,
    amount: UInt64,
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.RECLAIM_CHILD, 'Not a reclaim child tx');
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentApproval(
      proposal,
      parentApprovalWitness,
      parentApprovalCount,
    );

    this.assertChildExecutionWitnessValue(
      proposalHash,
      childExecutionWitness,
      Field(0),
    );
    this.assertAndIncrementParentNonce(proposal);

    proposal.data.assertEquals(amount.value, 'Data does not match reclaim amount');

    const parentAddress = this.parent.getAndRequireEquals();
    this.send({ to: parentAddress, amount });

    this.markChildExecuted(childExecutionWitness);

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });

    this.emitEvent('reclaimChild', {
      proposalHash,
      parentAddress,
      amount,
    });
  }

  /**
   * Destroys the child: sends full balance to parent and disables the
   * child's multisig policy. After destruction the child is inert —
   * propose/approve/execute are all blocked by
   * assertChildMultiSigEnabledIfChild, but parent-authorized lifecycle
   * methods remain callable.
   */
  @method async executeDestroy(
    proposal: TransactionProposal,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
    childExecutionWitness: MerkleMapWitness,
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.DESTROY_CHILD, 'Not a destroy child tx');
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentApproval(
      proposal,
      parentApprovalWitness,
      parentApprovalCount,
    );

    this.assertChildExecutionWitnessValue(
      proposalHash,
      childExecutionWitness,
      Field(0),
    );
    this.assertAndIncrementParentNonce(proposal);

    const balance = this.account.balance.getAndRequireEquals();
    const parentAddress = this.parent.getAndRequireEquals();
    this.send({ to: parentAddress, amount: balance });

    this.markChildExecuted(childExecutionWitness);

    this.childMultiSigEnabled.set(Field(0));

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });

    this.emitEvent('reclaimChild', {
      proposalHash,
      parentAddress,
      amount: balance,
    });

    this.emitEvent('enableChildMultiSig', {
      proposalHash,
      parentAddress,
      enabled: Field(0),
    });
  }

  /**
   * Toggles the child's independent multisig policy on/off. `enabled == 0`
   * blocks all child-local multisig ops; `enabled == 1` re-enables them.
   */
  @method async executeEnableChildMultiSig(
    proposal: TransactionProposal,
    parentApprovalWitness: MerkleMapWitness,
    parentApprovalCount: Field,
    childExecutionWitness: MerkleMapWitness,
    enabled: Field,
  ) {
    this.getInitializedOwnersCommitment();

    proposal.txType.assertEquals(TxType.ENABLE_CHILD_MULTI_SIG, 'Not an enable-child-multi-sig tx');
    this.assertValidRemoteProposal(proposal);

    const proposalHash = this.verifyParentApproval(
      proposal,
      parentApprovalWitness,
      parentApprovalCount,
    );

    this.assertChildExecutionWitnessValue(
      proposalHash,
      childExecutionWitness,
      Field(0),
    );
    this.assertAndIncrementParentNonce(proposal);

    proposal.data.assertEquals(enabled, 'Data does not match enabled flag');
    enabled.equals(Field(0)).or(enabled.equals(Field(1)))
      .assertTrue('Enabled must be 0 or 1');

    this.childMultiSigEnabled.set(enabled);

    this.markChildExecuted(childExecutionWitness);

    const parentAddress = this.parent.getAndRequireEquals();

    this.emitEvent('execution', {
      proposalHash,
      txType: proposal.txType,
    });

    this.emitEvent('enableChildMultiSig', {
      proposalHash,
      parentAddress,
      enabled,
    });
  }
}
