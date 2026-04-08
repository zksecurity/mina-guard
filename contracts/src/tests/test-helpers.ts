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
import { SignatureInputs, SignatureInput, SignatureOption } from '../batch-verify.js';

import { ownerKey } from '../utils.js';

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

// -- Batch Signature Helper --------------------------------------------------

export function makeSignatureInputs(
  ctx: TestContext,
  proposalHash: Field,
  signerIndices: number[]
): SignatureInputs {
  const inputs: SignatureInput[] = [];
  const dummySig = Signature.fromFields([Field(1), Field(1), Field(1)]);
  for (let i = 0; i < ctx.owners.length; i++) {
    const owner = ctx.owners[i];
    const shouldSign = signerIndices.includes(i);
    const sig = shouldSign
      ? Signature.create(owner.key, [proposalHash])
      : dummySig;
    inputs.push(
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: sig, isSome: Bool(shouldSign) }),
          signer: owner.pub,
        },
        isSome: Bool(true),
      })
    );
  }
  const dummyPk = PublicKey.fromFields([Field(1), Field(1)]);
  while (inputs.length < MAX_OWNERS) {
    inputs.push(
      new SignatureInput({
        value: {
          signature: new SignatureOption({ value: dummySig, isSome: Bool(false) }),
          signer: dummyPk,
        },
        isSome: Bool(false),
      })
    );
  }
  return new SignatureInputs({ inputs });
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
  threshold = 2,
): Promise<void> {
  const { zkApp, zkAppKey, zkAppAddress, deployerKey, deployerAccount, owners } = ctx;

  await deployAndSetupGuard(
    deployerAccount,
    deployerKey,
    zkApp,
    zkAppKey,
    zkAppAddress,
    owners.map((o) => o.pub),
    ctx.networkId,
    threshold,
  );
}

export async function deployAndSetupGuard(
  deployerAccount: PublicKey,
  deployerKey: PrivateKey,
  zkApp: MinaGuard,
  zkAppKey: PrivateKey,
  zkAppAddress: PublicKey,
  owners: PublicKey[],
  networkId: Field,
  threshold = 2,
): Promise<void> {
  const ownerPubs = [...owners];

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

  const ownersCommitment = computeOwnerChain(ownerPubs);
  const setupOwners = toFixedSetupOwners(ownerPubs);

  const setupTxn = await Mina.transaction(deployerAccount, async () => {
    await zkApp.setup(
      ownersCommitment,
      Field(threshold),
      Field(ownerPubs.length),
      networkId,
      new SetupOwnersInput({ owners: setupOwners })
    );
  });
  await setupTxn.prove();
  await setupTxn.sign([deployerKey, zkAppKey]).send();
}

/** Deploys a child guard and sets it up with parent approval via batch signatures. */
export async function deployAndSetupChildGuard(
  ctx: TestContext,
  parentAddress: PublicKey,
  childZkApp: MinaGuard,
  childKey: PrivateKey,
  childAddress: PublicKey,
  childOwners: PublicKey[],
  childThreshold: number,
  signerIndices: number[],
): Promise<void> {
  const { deployerAccount, deployerKey, networkId } = ctx;

  const deployTxn = await Mina.transaction(deployerAccount, async () => {
    AccountUpdate.fundNewAccount(deployerAccount);
    await childZkApp.deploy();
  });
  await deployTxn.prove();
  await deployTxn.sign([deployerKey, childKey]).send();

  const fundTxn = await Mina.transaction(deployerAccount, async () => {
    const update = AccountUpdate.createSigned(deployerAccount);
    update.send({ to: childAddress, amount: UInt64.from(10_000_000_000) });
  });
  await fundTxn.prove();
  await fundTxn.sign([deployerKey]).send();

  const ownersCommitment = computeOwnerChain(childOwners);
  const proposal = createCreateChildProposal(
    childAddress,
    ownersCommitment,
    Field(childThreshold),
    Field(childOwners.length),
    Field(0),
    Field(0),
    parentAddress,
    Field(0),
    networkId,
  );

  const proposalHash = proposal.hash();
  const sigs = makeSignatureInputs(ctx, proposalHash, signerIndices);
  const setupOwners = toFixedSetupOwners(childOwners);

  const setupTxn = await Mina.transaction(deployerAccount, async () => {
    await childZkApp.setupChild(
      ownersCommitment,
      Field(childThreshold),
      Field(childOwners.length),
      networkId,
      new SetupOwnersInput({ owners: setupOwners }),
      proposal,
      sigs,
    );
  });
  await setupTxn.prove();
  await setupTxn.sign([deployerKey, childKey]).send();
}

// -- Proposal Helpers --------------------------------------------------------

/** Builds a transfer proposal payload. Pads receivers to MAX_RECEIVERS. */
export function createTransferProposal(
  receivers: Receiver[],
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL
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
    uid,
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

/** Builds an add-owner governance proposal payload. */
export function createAddOwnerProposal(
  newOwner: PublicKey,
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.ADD_OWNER,
    data: ownerKey(newOwner),
    uid,
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
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.REMOVE_OWNER,
    data: ownerKey(ownerToRemove),
    uid,
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
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.CHANGE_THRESHOLD,
    data: newThreshold,
    uid,
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
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.SET_DELEGATE,
    data: ownerKey(delegate),
    uid,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/** Builds an un-delegate proposal payload (data=0). */
export function createUndelegateProposal(
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
  destination = Destination.LOCAL
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.SET_DELEGATE,
    data: Field(0),
    uid,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination,
    childAccount,
  });
}

/** Builds a CREATE_CHILD proposal payload. data = Poseidon.hash(ownersCommitment, threshold, numOwners). */
export function createCreateChildProposal(
  childAccount: PublicKey,
  ownersCommitment: Field,
  threshold: Field,
  numOwners: Field,
  uid: Field,
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
    uid,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

export function createAllocateChildProposal(
  receivers: Receiver[],
  uid: Field,
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
    uid,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

export function createReclaimChildProposal(
  amount: UInt64,
  uid: Field,
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
    uid,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

export function createDestroyChildProposal(
  uid: Field,
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
    uid,
    configNonce,
    expiryBlock,
    networkId,
    guardAddress,
    destination: Destination.REMOTE,
    childAccount,
  });
}

export function createTogglePolicyProposal(
  enabled: Field,
  uid: Field,
  configNonce: Field,
  guardAddress: PublicKey,
  expiryBlock = Field(0),
  networkId = Field(1),
  childAccount = PublicKey.empty(),
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.TOGGLE_POLICY,
    data: enabled,
    uid,
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
