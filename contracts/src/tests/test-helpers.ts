import {
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  AccountUpdate,
  Signature,
  Poseidon,
  UInt64,
  Bool,
  MerkleMapWitness,
} from 'o1js';
import {
  MinaGuard,
  Receiver,
  SetupOwnersInput,
  TransactionProposal,
} from '../MinaGuard.js';
import {
  TxType,
  Destination,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
} from '../constants.js';
import { ApprovalStore, VoteNullifierStore } from '../storage.js';
import { PublicKeyOption, computeOwnerChain, OwnerWitness } from '../list-commitment.js';

// -- Types -------------------------------------------------------------------

/** Shared context used by integration-style contract tests. */
export interface TestContext {
  zkApp: MinaGuard;
  zkAppKey: PrivateKey;
  zkAppAddress: PublicKey;
  deployerKey: PrivateKey;
  deployerAccount: PublicKey;
  owners: { key: PrivateKey; pub: PublicKey }[];
  approvalStore: ApprovalStore;
  nullifierStore: VoteNullifierStore;
  networkId: Field;
}

// -- Owner Witness Helper ----------------------------------------------------

export function makeOwnerWitness(owners: PublicKey[]): OwnerWitness {
  const ownerOptions = owners.map(
    (pk) => new PublicKeyOption({ value: pk, isSome: Bool(true) })
  );
  while (ownerOptions.length < MAX_OWNERS) {
    ownerOptions.push(PublicKeyOption.none());
  }
  return new OwnerWitness({ owners: ownerOptions });
}

/**
 * Returns the insertAfter option for adding `newOwner` into the sorted owner list.
 * Returns none if the new owner would be first (prepend).
 */
export function sortedInsertAfter(owners: PublicKey[], newOwner: PublicKey): PublicKeyOption {
  const b58 = newOwner.toBase58();
  let pred: PublicKey | null = null;
  for (const o of owners) {
    if (o.toBase58() < b58) pred = o;
  }
  return pred
    ? new PublicKeyOption({ value: pred, isSome: Bool(true) })
    : PublicKeyOption.none();
}

// -- Setup Helpers -----------------------------------------------------------

/** Pads the owner list to the fixed setup input length required by the contract. */
export function toFixedSetupOwners(owners: PublicKey[]): PublicKey[] {
  const padded = [...owners];
  while (padded.length < MAX_OWNERS) {
    padded.push(PublicKey.empty());
  }
  return padded.slice(0, MAX_OWNERS);
}

/** Creates and activates a local Mina blockchain test context with funded accounts. */
export async function setupLocalBlockchain(numOwners = 3): Promise<TestContext> {
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);

  const deployerKey = Local.testAccounts[0].key;
  const deployerAccount = Local.testAccounts[0];

  const availableAccounts = Local.testAccounts.length - 1; // reserve index 0 for deployer
  const owners: { key: PrivateKey; pub: PublicKey }[] = [];
  for (let i = 0; i < numOwners; i++) {
    if (i < availableAccounts) {
      owners.push({
        key: Local.testAccounts[i + 1].key,
        pub: Local.testAccounts[i + 1],
      });
    } else {
      const key = PrivateKey.random();
      owners.push({ key, pub: key.toPublicKey() });
    }
  }
  // Canonical ascending base58 order for deterministic owner chain commitments
  owners.sort((a, b) => a.pub.toBase58() > b.pub.toBase58() ? 1 : -1);

  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();
  const zkApp = new MinaGuard(zkAppAddress);

  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();
  const networkId = Field(1);

  return {
    zkApp,
    zkAppKey,
    zkAppAddress,
    deployerKey,
    deployerAccount,
    owners,
    approvalStore,
    nullifierStore,
    networkId,
  };
}

export function getOwnersCommitment(ctx: TestContext): Field {
  return computeOwnerChain(ctx.owners.map((o) => o.pub));
}

/** Deploys MinaGuard, funds it, and performs one-time setup. */
export async function deployAndSetup(
  ctx: TestContext,
  threshold = 2
): Promise<void> {
  const { zkApp, zkAppKey, zkAppAddress, deployerKey, deployerAccount, owners } = ctx;

  const deployTxn = await Mina.transaction(deployerAccount, async () => {
    AccountUpdate.fundNewAccount(deployerAccount);
    await zkApp.deploy();
  });
  await deployTxn.prove();
  await deployTxn.sign([deployerKey, zkAppKey]).send();

  const fundTxn = await Mina.transaction(deployerAccount, async () => {
    const update = AccountUpdate.createSigned(deployerAccount);
    update.send({ to: zkAppAddress, amount: UInt64.from(10_000_000_000) });
  });
  await fundTxn.prove();
  await fundTxn.sign([deployerKey]).send();

  const ownersCommitment = computeOwnerChain(owners.map((o) => o.pub));
  const setupOwners = toFixedSetupOwners(owners.map((o) => o.pub));

  const setupTxn = await Mina.transaction(deployerAccount, async () => {
    await zkApp.setup(
      ownersCommitment,
      Field(threshold),
      Field(owners.length),
      ctx.networkId,
      new SetupOwnersInput({ owners: setupOwners })
    );
  });
  await setupTxn.prove();
  await setupTxn.sign([deployerKey, zkAppKey]).send();
}

// -- Proposal Helpers --------------------------------------------------------

/** Builds a transfer proposal payload. Pads receivers to MAX_RECEIVERS. */
export function createTransferProposal(
  receivers: Receiver[],
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL,
  memoHash = Field(0),
): TransactionProposal {
  const padded = [...receivers];
  while (padded.length < MAX_RECEIVERS) {
    padded.push(Receiver.empty());
  }
  return new TransactionProposal({
    receivers: padded,
    tokenId: Field(0),
    txType: TxType.TRANSFER,
    data: Field(0),
    memoHash,
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

function emptyReceivers(): Receiver[] {
  return Array.from({ length: MAX_RECEIVERS }, () => Receiver.empty());
}

function singleReceiverArray(address: PublicKey): Receiver[] {
  const arr = emptyReceivers();
  arr[0] = new Receiver({ address, amount: UInt64.from(0) });
  return arr;
}

/** Builds an add-owner governance proposal payload. */
export function createAddOwnerProposal(
  newOwner: PublicKey,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL,
  memoHash = Field(0),
): TransactionProposal {
  return new TransactionProposal({
    receivers: singleReceiverArray(newOwner),
    tokenId: Field(0),
    txType: TxType.ADD_OWNER,
    data: Field(0),
    memoHash,
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/** Builds a remove-owner governance proposal payload. */
export function createRemoveOwnerProposal(
  ownerToRemove: PublicKey,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL,
  memoHash = Field(0),
): TransactionProposal {
  return new TransactionProposal({
    receivers: singleReceiverArray(ownerToRemove),
    tokenId: Field(0),
    txType: TxType.REMOVE_OWNER,
    data: Field(0),
    memoHash,
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/** Builds a threshold-change governance proposal payload. */
export function createThresholdProposal(
  newThreshold: Field,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL,
  memoHash = Field(0),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.CHANGE_THRESHOLD,
    data: newThreshold,
    memoHash,
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/** Builds a delegate proposal payload. */
export function createDelegateProposal(
  delegate: PublicKey,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL,
  memoHash = Field(0),
): TransactionProposal {
  return new TransactionProposal({
    receivers: singleReceiverArray(delegate),
    tokenId: Field(0),
    txType: TxType.SET_DELEGATE,
    data: Field(0),
    memoHash,
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/** Builds an un-delegate proposal payload (empty receivers[0]). */
export function createUndelegateProposal(
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL,
  memoHash = Field(0),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.SET_DELEGATE,
    data: Field(0),
    memoHash,
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/**
 * Builds a LOCAL zero-value transfer used by the delete flow — receivers[0]
 * is (PublicKey.empty(), 0), the rest are empty. Same nonce as the target
 * proposal: whichever executes first burns the slot and invalidates the other.
 */
export function createDeleteProposal(
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
): TransactionProposal {
  const receivers = emptyReceivers();
  receivers[0] = new Receiver({ address: PublicKey.empty(), amount: UInt64.zero });
  return new TransactionProposal({
    receivers,
    tokenId: Field(0),
    txType: TxType.TRANSFER,
    data: Field(0),
    memoHash: Field(0),
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

// -- Child Proposal Helpers --------------------------------------------------

/**
 * Builds a CREATE_CHILD proposal. `data` is the Poseidon commitment of the
 * child's intended config so the child's executeSetupChild can bind to it.
 * REMOTE destination, targets the given child address.
 */
export function createCreateChildProposal(
  childAccount: PublicKey,
  ownersCommitment: Field,
  threshold: Field,
  numOwners: Field,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.CREATE_CHILD,
    data: Poseidon.hash([ownersCommitment, threshold, numOwners]),
    memoHash: Field(0),
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

/**
 * Builds an ALLOCATE_CHILD proposal — LOCAL on the parent, uses receivers as
 * (childAddress, amount) pairs.
 */
export function createAllocateChildProposal(
  receivers: Receiver[],
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
): TransactionProposal {
  const padded = [...receivers];
  while (padded.length < MAX_RECEIVERS) {
    padded.push(Receiver.empty());
  }
  return new TransactionProposal({
    receivers: padded,
    tokenId: Field(0),
    txType: TxType.ALLOCATE_CHILD,
    data: Field(0),
    memoHash: Field(0),
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

/**
 * Builds a RECLAIM_CHILD proposal — REMOTE, proposed on the parent, targets
 * a specific child. `data` encodes the reclaim amount.
 */
export function createReclaimChildProposal(
  amount: UInt64,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.RECLAIM_CHILD,
    data: amount.value,
    memoHash: Field(0),
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

/** Builds a DESTROY_CHILD proposal — REMOTE, proposed on the parent. */
export function createDestroyChildProposal(
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.DESTROY_CHILD,
    data: Field(0),
    memoHash: Field(0),
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

/** Builds an ENABLE_CHILD_MULTI_SIG proposal — REMOTE, data encodes the flag. */
export function createEnableChildMultiSigProposal(
  enabled: Field,
  nonce: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.ENABLE_CHILD_MULTI_SIG,
    data: enabled,
    memoHash: Field(0),
    nonce,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

// -- Transaction Helpers -----------------------------------------------------

/** Submits a propose call and updates off-chain stores to mirror on-chain mutations. */
export async function proposeTransaction(
  ctx: TestContext,
  proposal: TransactionProposal,
  proposerIndex: number
): Promise<Field> {
  const { zkApp, approvalStore, nullifierStore, owners } = ctx;
  const proposer = owners[proposerIndex];

  const proposalHash = proposal.hash();

  const ownerWitness = makeOwnerWitness(owners.map((o) => o.pub));
  const sig = Signature.create(proposer.key, [proposalHash]);
  const nullifierWitness = nullifierStore.getWitness(proposalHash, proposer.pub);
  const approvalWitness = approvalStore.getWitness(proposalHash);
  const txn = await Mina.transaction(proposer.pub, async () => {
    await zkApp.propose(
      proposal,
      ownerWitness,
      proposer.pub,
      sig,
      nullifierWitness,
      approvalWitness
    );
  });
  await txn.prove();
  await txn.sign([proposer.key]).send();

  nullifierStore.nullify(proposalHash, proposer.pub);
  approvalStore.setCount(proposalHash, PROPOSED_MARKER.add(1));

  return proposalHash;
}

/** Submits approveProposal for an owner and syncs the local store mirrors. */
export async function approveTransaction(
  ctx: TestContext,
  proposal: TransactionProposal,
  approverIndex: number
): Promise<void> {
  const { zkApp, approvalStore, nullifierStore, owners } = ctx;
  const approver = owners[approverIndex];
  const proposalHash = proposal.hash();

  const sig = Signature.create(approver.key, [proposalHash]);
  const currentCount = approvalStore.getCount(proposalHash);
  const ownerWitness = makeOwnerWitness(owners.map((o) => o.pub));
  const approvalWitness = approvalStore.getWitness(proposalHash);
  const nullifierWitness = nullifierStore.getWitness(proposalHash, approver.pub);

  const txn = await Mina.transaction(approver.pub, async () => {
    await zkApp.approveProposal(
      proposal,
      sig,
      approver.pub,
      ownerWitness,
      approvalWitness,
      currentCount,
      nullifierWitness
    );
  });
  await txn.prove();
  await txn.sign([approver.key]).send();

  nullifierStore.nullify(proposalHash, approver.pub);
  const newCount = Field(Number(currentCount.toString()) + 1);
  approvalStore.setCount(proposalHash, newCount);
}

/**
 * Runs propose + approve on the parent guard so a REMOTE proposal reaches
 * threshold. Returns the parent approvalRoot witness and the accumulated
 * approval count — exactly what a child's lifecycle method needs to pass to
 * verifyParentApproval. Caller is responsible for ensuring `signerIndices`
 * contains exactly `threshold` distinct owners starting with the proposer.
 */
export async function proposeAndApproveOnParent(
  parentCtx: TestContext,
  proposal: TransactionProposal,
  signerIndices: number[],
): Promise<{
  proposalHash: Field;
  parentApprovalCount: Field;
  parentApprovalWitness: MerkleMapWitness;
}> {
  if (signerIndices.length === 0) {
    throw new Error('proposeAndApproveOnParent: need at least one signer');
  }
  const [proposerIndex, ...approverIndices] = signerIndices;

  const proposalHash = await proposeTransaction(parentCtx, proposal, proposerIndex);
  for (const idx of approverIndices) {
    await approveTransaction(parentCtx, proposal, idx);
  }

  const parentApprovalCount = parentCtx.approvalStore.getCount(proposalHash);
  const parentApprovalWitness = parentCtx.approvalStore.getWitness(proposalHash);

  return { proposalHash, parentApprovalCount, parentApprovalWitness };
}

/**
 * Deploys, funds, and runs `executeSetupChild` on a new child guard — all
 * in a SINGLE Mina transaction. The CREATE_CHILD proposal must already have
 * reached threshold on the parent via `proposeAndApproveOnParent`.
 *
 * The single-transaction pattern is load-bearing: between a standalone
 * deploy and a standalone executeSetupChild, the child sits on-chain with
 * `ownersCommitment == 0`, and anyone watching the mempool could call
 * `executeSetupChild` with a proposal bound to an attacker-controlled
 * "parent" and permanently bind the child to a hostile parent. Batching
 * them in one tx eliminates that window.
 */
export async function deployAndSetupChildGuard(
  parentCtx: TestContext,
  parentAddress: PublicKey,
  childZkApp: MinaGuard,
  childKey: PrivateKey,
  childAddress: PublicKey,
  childOwners: PublicKey[],
  childThreshold: number,
  signerIndices: number[],
  nonce = Field(0),
): Promise<{ proposalHash: Field }> {
  const { deployerAccount, deployerKey, networkId } = parentCtx;

  const ownersCommitment = computeOwnerChain(childOwners);
  const thresholdField = Field(childThreshold);
  const numOwnersField = Field(childOwners.length);

  const proposal = createCreateChildProposal(
    childAddress,
    ownersCommitment,
    thresholdField,
    numOwnersField,
    nonce,
    Field(0), // parent's configNonce at time of propose
    parentAddress,
    Field(0),
    networkId,
  );

  const { proposalHash, parentApprovalCount, parentApprovalWitness } =
    await proposeAndApproveOnParent(parentCtx, proposal, signerIndices);

  const setupOwners = toFixedSetupOwners(childOwners);

  const atomicTxn = await Mina.transaction(deployerAccount, async () => {
    AccountUpdate.fundNewAccount(deployerAccount);
    await childZkApp.deploy();
    const funder = AccountUpdate.createSigned(deployerAccount);
    funder.send({ to: childAddress, amount: UInt64.from(10_000_000_000) });
    await childZkApp.executeSetupChild(
      ownersCommitment,
      thresholdField,
      numOwnersField,
      new SetupOwnersInput({ owners: setupOwners }),
      proposal,
      parentApprovalWitness,
      parentApprovalCount,
    );
  });
  await atomicTxn.prove();
  await atomicTxn.sign([deployerKey, childKey]).send();

  return { proposalHash };
}

/** Reads an account balance from the active Mina instance. */
export function getBalance(address: PublicKey): UInt64 {
  return Mina.getBalance(address);
}

/** Funds an account in local tests so transfer assertions can run safely. */
export async function fundAccount(
  ctx: TestContext,
  address: PublicKey
): Promise<void> {
  const { deployerKey, deployerAccount } = ctx;
  const txn = await Mina.transaction(deployerAccount, async () => {
    AccountUpdate.fundNewAccount(deployerAccount);
    const update = AccountUpdate.createSigned(deployerAccount);
    update.send({ to: address, amount: UInt64.from(1_000_000) });
  });
  await txn.prove();
  await txn.sign([deployerKey]).send();
}
