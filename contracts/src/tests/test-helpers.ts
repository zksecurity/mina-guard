import {
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  AccountUpdate,
  Signature,
  UInt64,
} from 'o1js';
import {
  MinaGuard,
  TransactionProposal,
  TxType,
  ownerKey,
} from '../MinaGuard.js';
import { OwnerStore, ApprovalStore, VoteNullifierStore } from '../storage.js';

// -- Types -------------------------------------------------------------------

export interface TestContext {
  zkApp: MinaGuard;
  zkAppKey: PrivateKey;
  zkAppAddress: PublicKey;
  deployerKey: PrivateKey;
  deployerAccount: PublicKey;
  owners: { key: PrivateKey; pub: PublicKey }[];
  ownerStore: OwnerStore;
  approvalStore: ApprovalStore;
  nullifierStore: VoteNullifierStore;
}

// -- Setup Helpers -----------------------------------------------------------

export async function setupLocalBlockchain(numOwners = 3): Promise<TestContext> {
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);

  const deployerKey = Local.testAccounts[0].key;
  const deployerAccount = Local.testAccounts[0];

  const owners: { key: PrivateKey; pub: PublicKey }[] = [];
  for (let i = 0; i < numOwners; i++) {
    owners.push({
      key: Local.testAccounts[i + 1].key,
      pub: Local.testAccounts[i + 1],
    });
  }

  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();
  const zkApp = new MinaGuard(zkAppAddress);

  const ownerStore = new OwnerStore();
  for (const o of owners) ownerStore.add(o.pub);

  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();

  return {
    zkApp,
    zkAppKey,
    zkAppAddress,
    deployerKey,
    deployerAccount,
    owners,
    ownerStore,
    approvalStore,
    nullifierStore,
  };
}

export async function deployAndSetup(
  ctx: TestContext,
  threshold = 2
): Promise<void> {
  const { zkApp, zkAppKey, zkAppAddress, deployerKey, deployerAccount, ownerStore, owners } = ctx;

  const deployTxn = await Mina.transaction(deployerAccount, async () => {
    AccountUpdate.fundNewAccount(deployerAccount);
    await zkApp.deploy();
  });
  await deployTxn.prove();
  await deployTxn.sign([deployerKey, zkAppKey]).send();

  // Fund the wallet
  const fundTxn = await Mina.transaction(deployerAccount, async () => {
    const update = AccountUpdate.createSigned(deployerAccount);
    update.send({ to: zkAppAddress, amount: UInt64.from(10_000_000_000) });
  });
  await fundTxn.prove();
  await fundTxn.sign([deployerKey]).send();

  const setupTxn = await Mina.transaction(deployerAccount, async () => {
    await zkApp.setup(
      ownerStore.getRoot(),
      Field(threshold),
      Field(owners.length)
    );
  });
  await setupTxn.prove();
  await setupTxn.sign([deployerKey, zkAppKey]).send();
}

// -- Proposal Helpers --------------------------------------------------------

export function createTransferProposal(
  to: PublicKey,
  amount: UInt64,
  nonce: Field,
  configNonce: Field,
  expiryBlock = Field(0)
): TransactionProposal {
  return new TransactionProposal({
    to,
    amount,
    tokenId: Field(0),
    txType: TxType.TRANSFER,
    data: Field(0),
    nonce,
    configNonce,
    expiryBlock,
  });
}

export function createAddOwnerProposal(
  newOwner: PublicKey,
  nonce: Field,
  configNonce: Field,
  expiryBlock = Field(0)
): TransactionProposal {
  return new TransactionProposal({
    to: PublicKey.empty(),
    amount: UInt64.from(0),
    tokenId: Field(0),
    txType: TxType.ADD_OWNER,
    data: ownerKey(newOwner),
    nonce,
    configNonce,
    expiryBlock,
  });
}

export function createRemoveOwnerProposal(
  ownerToRemove: PublicKey,
  nonce: Field,
  configNonce: Field,
  expiryBlock = Field(0)
): TransactionProposal {
  return new TransactionProposal({
    to: PublicKey.empty(),
    amount: UInt64.from(0),
    tokenId: Field(0),
    txType: TxType.REMOVE_OWNER,
    data: ownerKey(ownerToRemove),
    nonce,
    configNonce,
    expiryBlock,
  });
}

export function createThresholdProposal(
  newThreshold: Field,
  nonce: Field,
  configNonce: Field,
  expiryBlock = Field(0)
): TransactionProposal {
  return new TransactionProposal({
    to: PublicKey.empty(),
    amount: UInt64.from(0),
    tokenId: Field(0),
    txType: TxType.CHANGE_THRESHOLD,
    data: newThreshold,
    nonce,
    configNonce,
    expiryBlock,
  });
}

// -- Transaction Helpers -----------------------------------------------------

export async function proposeTransaction(
  ctx: TestContext,
  proposal: TransactionProposal,
  proposerIndex: number
): Promise<Field> {
  const { zkApp, zkAppKey, ownerStore, owners } = ctx;
  const proposer = owners[proposerIndex];

  const ownerWitness = ownerStore.getWitness(proposer.pub);
  const txn = await Mina.transaction(proposer.pub, async () => {
    await zkApp.propose(proposal, ownerWitness, proposer.pub);
  });
  await txn.prove();
  await txn.sign([proposer.key, zkAppKey]).send();

  const txHash = proposal.hash();

  // Initialize approval count to 0
  ctx.approvalStore.setCount(txHash, Field(0));

  return txHash;
}

export async function proposeAndApproveTransaction(
  ctx: TestContext,
  proposal: TransactionProposal,
  proposerIndex: number
): Promise<Field> {
  const { zkApp, zkAppKey, ownerStore, approvalStore, nullifierStore, owners } = ctx;
  const proposer = owners[proposerIndex];
  const txHash = proposal.hash();

  const ownerWitness = ownerStore.getWitness(proposer.pub);
  const sig = Signature.create(proposer.key, [txHash]);
  const nullifierWitness = nullifierStore.getWitness(txHash, proposer.pub);
  const approvalWitness = approvalStore.getWitness(txHash);

  const txn = await Mina.transaction(proposer.pub, async () => {
    await zkApp.proposeAndApprove(
      proposal,
      ownerWitness,
      proposer.pub,
      sig,
      nullifierWitness,
      approvalWitness
    );
  });
  await txn.prove();
  await txn.sign([proposer.key, zkAppKey]).send();

  // Update off-chain stores
  nullifierStore.nullify(txHash, proposer.pub);
  approvalStore.setCount(txHash, Field(1));

  return txHash;
}

export async function approveTransaction(
  ctx: TestContext,
  proposal: TransactionProposal,
  approverIndex: number
): Promise<void> {
  const { zkApp, zkAppKey, ownerStore, approvalStore, nullifierStore, owners } = ctx;
  const approver = owners[approverIndex];
  const txHash = proposal.hash();

  const sig = Signature.create(approver.key, [txHash]);
  const currentCount = approvalStore.getCount(txHash);
  const ownerWitness = ownerStore.getWitness(approver.pub);
  const approvalWitness = approvalStore.getWitness(txHash);
  const nullifierWitness = nullifierStore.getWitness(txHash, approver.pub);

  const txn = await Mina.transaction(approver.pub, async () => {
    await zkApp.approveTx(
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
  await txn.sign([approver.key, zkAppKey]).send();

  // Update off-chain stores
  nullifierStore.nullify(txHash, approver.pub);
  const newCount = Field(Number(currentCount.toString()) + 1);
  approvalStore.setCount(txHash, newCount);
}

export function getBalance(address: PublicKey): UInt64 {
  return Mina.getBalance(address);
}

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
