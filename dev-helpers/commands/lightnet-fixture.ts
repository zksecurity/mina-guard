import {
  AccountUpdate,
  Bool,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  Signature,
  UInt64,
  fetchAccount,
} from 'o1js';

import {
  ApprovalStore,
  Destination,
  EXECUTED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
  MinaGuard,
  OwnerStore,
  PROPOSED_MARKER,
  PublicKeyOption,
  Receiver,
  SetupOwnersInput,
  TransactionProposal,
  TxType,
  VoteNullifierStore,
} from 'contracts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DEFAULT_PREVIEW_BASE_URL = 'https://localhost:10001/preview/1';
const NETWORK_ID = Field(0);
const TX_FEE = 100_000_000;
const MAIN_ACCOUNT_FUNDING = UInt64.from(5_000_000_000);
const TRANSFER_CONTRACT_FUNDING = UInt64.from(8_000_000_000);

type FixtureScenario = 'minimal' | 'full';

interface LightnetFixtureOptions {
  mainAddress: string;
  previewBaseUrl?: string;
  scenario?: FixtureScenario;
}

interface ManagedSigner {
  label: string;
  publicKey: string;
  privateKey: string;
  pub: PublicKey;
  key: PrivateKey;
}

interface FixtureContract {
  label: string;
  zkAppKey: PrivateKey;
  zkAppAddress: PublicKey;
  ownerStore: OwnerStore;
  approvalStore: ApprovalStore;
  nullifierStore: VoteNullifierStore;
  nextProposalNonce: number;
  configNonce: number;
  threshold: number;
}

interface FixtureSummary {
  scenario: FixtureScenario;
  mainAddress: string;
  signers: Array<{ label: string; publicKey: string }>;
  contracts: Array<{
    label: string;
    address: string;
    scenarios: string[];
  }>;
}

function log(message: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[fixture ${ts}] ${message}`);
}

function normalizeBaseUrl(url?: string): string {
  const raw = (url ?? DEFAULT_PREVIEW_BASE_URL).trim().replace(/\/+$/, '');
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    throw new Error(`previewBaseUrl must start with http:// or https://, got: ${raw}`);
  }
  return raw;
}

function normalizeScenario(scenario?: string): FixtureScenario {
  if (!scenario) return 'minimal';
  if (scenario === 'minimal' || scenario === 'full') return scenario;
  throw new Error(`Unknown fixture scenario: ${scenario}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function waitForCondition(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 300_000,
  intervalMs = 5_000,
) {
  log(`Waiting for ${label}...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      log(`${label} ready`);
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function acquireLightnetAccount(accountManagerUrl: string, label: string): Promise<ManagedSigner> {
  const data = await fetchJson<{ pk: string; sk: string }>(`${accountManagerUrl}/acquire-account`);
  return {
    label,
    publicKey: data.pk,
    privateKey: data.sk,
    pub: PublicKey.fromBase58(data.pk),
    key: PrivateKey.fromBase58(data.sk),
  };
}

function generateSigner(label: string): ManagedSigner {
  const key = PrivateKey.random();
  const pub = key.toPublicKey();
  return {
    label,
    publicKey: pub.toBase58(),
    privateKey: key.toBase58(),
    pub,
    key,
  };
}

function emptyReceivers(): Receiver[] {
  return Array.from({ length: MAX_RECEIVERS }, () => Receiver.empty());
}

function singleReceiverArray(address: PublicKey): Receiver[] {
  const receivers = emptyReceivers();
  receivers[0] = new Receiver({ address, amount: UInt64.from(0) });
  return receivers;
}

function paddedOwners(ownerStore: OwnerStore): PublicKey[] {
  const owners = [...ownerStore.owners];
  while (owners.length < MAX_OWNERS) owners.push(PublicKey.empty());
  return owners.slice(0, MAX_OWNERS);
}

function createTransferProposal(
  contractAddress: PublicKey,
  nonce: number,
  configNonce: number,
  receivers: Array<{ address: PublicKey; amount: UInt64 }>,
): TransactionProposal {
  const padded = receivers.map((receiver) => new Receiver(receiver));
  while (padded.length < MAX_RECEIVERS) padded.push(Receiver.empty());

  return new TransactionProposal({
    receivers: padded,
    tokenId: Field(0),
    txType: TxType.TRANSFER,
    data: Field(0),
    nonce: Field(nonce),
    configNonce: Field(configNonce),
    expiryBlock: Field(0),
    networkId: NETWORK_ID,
    guardAddress: contractAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

function createAddOwnerProposal(
  contractAddress: PublicKey,
  nonce: number,
  configNonce: number,
  newOwner: PublicKey,
): TransactionProposal {
  return new TransactionProposal({
    receivers: singleReceiverArray(newOwner),
    tokenId: Field(0),
    txType: TxType.ADD_OWNER,
    data: Field(0),
    nonce: Field(nonce),
    configNonce: Field(configNonce),
    expiryBlock: Field(0),
    networkId: NETWORK_ID,
    guardAddress: contractAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

function createRemoveOwnerProposal(
  contractAddress: PublicKey,
  nonce: number,
  configNonce: number,
  ownerToRemove: PublicKey,
): TransactionProposal {
  return new TransactionProposal({
    receivers: singleReceiverArray(ownerToRemove),
    tokenId: Field(0),
    txType: TxType.REMOVE_OWNER,
    data: Field(0),
    nonce: Field(nonce),
    configNonce: Field(configNonce),
    expiryBlock: Field(0),
    networkId: NETWORK_ID,
    guardAddress: contractAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

function createThresholdProposal(
  contractAddress: PublicKey,
  nonce: number,
  configNonce: number,
  newThreshold: number,
): TransactionProposal {
  return new TransactionProposal({
    receivers: emptyReceivers(),
    tokenId: Field(0),
    txType: TxType.CHANGE_THRESHOLD,
    data: Field(newThreshold),
    nonce: Field(nonce),
    configNonce: Field(configNonce),
    expiryBlock: Field(0),
    networkId: NETWORK_ID,
    guardAddress: contractAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

function createDelegateProposal(
  contractAddress: PublicKey,
  nonce: number,
  configNonce: number,
  delegate: PublicKey,
): TransactionProposal {
  return new TransactionProposal({
    receivers: singleReceiverArray(delegate),
    tokenId: Field(0),
    txType: TxType.SET_DELEGATE,
    data: Field(0),
    nonce: Field(nonce),
    configNonce: Field(configNonce),
    expiryBlock: Field(0),
    networkId: NETWORK_ID,
    guardAddress: contractAddress,
    destination: Destination.LOCAL,
    childAccount: PublicKey.empty(),
  });
}

async function submitTransaction(
  label: string,
  tx: Awaited<ReturnType<typeof Mina.transaction>>,
  signers: PrivateKey[],
) {
  log(`${label}: proving`);
  await tx.prove();
  tx.sign(signers);

  log(`${label}: sending`);
  const pending = await tx.send();
  const pendingWithHash = pending as { hash?: string | (() => string | undefined) };
  const hash =
    typeof pendingWithHash.hash === 'function'
      ? pendingWithHash.hash() ?? 'unknown'
      : pendingWithHash.hash ?? 'unknown';
  await pending.wait({ maxAttempts: 120, interval: 2_000 });
  log(`${label}: included (${hash})`);
  return hash;
}

async function maybeFundNewAccount(funder: ManagedSigner, target: PublicKey, amount: UInt64, label: string) {
  const targetAccount = await fetchAccount({ publicKey: target });
  const isNew = !targetAccount.account;

  const tx = await Mina.transaction({ sender: funder.pub, fee: TX_FEE }, async () => {
    if (isNew) {
      AccountUpdate.fundNewAccount(funder.pub);
    }
    const update = AccountUpdate.createSigned(funder.pub);
    update.send({ to: target, amount });
  });

  await submitTransaction(label, tx, [funder.key]);
}

async function createFixtureContract(
  label: string,
  deployer: ManagedSigner,
  owners: PublicKey[],
  threshold: number,
  fundContractAmount?: UInt64,
): Promise<FixtureContract> {
  const ownerStore = new OwnerStore();
  for (const owner of owners) ownerStore.addSorted(owner);

  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();
  const zkApp = new MinaGuard(zkAppAddress);

  const deployTx = await Mina.transaction({ sender: deployer.pub, fee: TX_FEE }, async () => {
    AccountUpdate.fundNewAccount(deployer.pub);
    await zkApp.deploy();
    await zkApp.setup(
      ownerStore.getCommitment(),
      Field(threshold),
      Field(ownerStore.length),
      NETWORK_ID,
      new SetupOwnersInput({ owners: paddedOwners(ownerStore) }),
    );
    if (fundContractAmount) {
      const update = AccountUpdate.createSigned(deployer.pub);
      update.send({ to: zkAppAddress, amount: fundContractAmount });
    }
  });

  await submitTransaction(`${label}: deploy+setup`, deployTx, [deployer.key, zkAppKey]);

  return {
    label,
    zkAppKey,
    zkAppAddress,
    ownerStore,
    approvalStore: new ApprovalStore(),
    nullifierStore: new VoteNullifierStore(),
    nextProposalNonce: 1,
    configNonce: 0,
    threshold,
  };
}

async function propose(
  contract: FixtureContract,
  proposer: ManagedSigner,
  proposal: TransactionProposal,
  label: string,
  feePayer: ManagedSigner = proposer,
) {
  const proposalHash = proposal.hash();
  const ownerWitness = contract.ownerStore.getWitness();
  const approvalWitness = contract.approvalStore.getWitness(proposalHash);
  const nullifierWitness = contract.nullifierStore.getWitness(proposalHash, proposer.pub);
  const signature = Signature.create(proposer.key, [proposalHash]);
  const zkApp = new MinaGuard(contract.zkAppAddress);

  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
    await zkApp.propose(
      proposal,
      ownerWitness,
      proposer.pub,
      signature,
      nullifierWitness,
      approvalWitness,
    );
  });

  await submitTransaction(label, tx, [feePayer.key]);
  contract.nullifierStore.nullify(proposalHash, proposer.pub);
  contract.approvalStore.setCount(proposalHash, PROPOSED_MARKER.add(1));
  return proposalHash;
}

async function approve(
  contract: FixtureContract,
  approver: ManagedSigner,
  proposal: TransactionProposal,
  label: string,
  feePayer: ManagedSigner = approver,
) {
  const proposalHash = proposal.hash();
  const currentApprovalCount = contract.approvalStore.getCount(proposalHash);
  const ownerWitness = contract.ownerStore.getWitness();
  const approvalWitness = contract.approvalStore.getWitness(proposalHash);
  const nullifierWitness = contract.nullifierStore.getWitness(proposalHash, approver.pub);
  const signature = Signature.create(approver.key, [proposalHash]);
  const zkApp = new MinaGuard(contract.zkAppAddress);

  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
    await zkApp.approveProposal(
      proposal,
      signature,
      approver.pub,
      ownerWitness,
      approvalWitness,
      currentApprovalCount,
      nullifierWitness,
    );
  });

  await submitTransaction(label, tx, [feePayer.key]);
  contract.nullifierStore.nullify(proposalHash, approver.pub);
  contract.approvalStore.setCount(proposalHash, currentApprovalCount.add(1));
}

async function executeTransfer(
  contract: FixtureContract,
  executor: ManagedSigner,
  proposal: TransactionProposal,
  label: string,
  feePayer: ManagedSigner = executor,
) {
  const proposalHash = proposal.hash();
  const approvalCount = contract.approvalStore.getCount(proposalHash);
  const approvalWitness = contract.approvalStore.getWitness(proposalHash);
  const zkApp = new MinaGuard(contract.zkAppAddress);

  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
    await zkApp.executeTransfer(proposal, approvalWitness, approvalCount);
  });

  await submitTransaction(label, tx, [feePayer.key]);
  contract.approvalStore.setCount(proposalHash, EXECUTED_MARKER);
}

async function executeOwnerChange(
  contract: FixtureContract,
  executor: ManagedSigner,
  proposal: TransactionProposal,
  label: string,
  feePayer: ManagedSigner = executor,
) {
  const proposalHash = proposal.hash();
  const approvalCount = contract.approvalStore.getCount(proposalHash);
  const approvalWitness = contract.approvalStore.getWitness(proposalHash);
  const zkApp = new MinaGuard(contract.zkAppAddress);

  const target = proposal.receivers[0].address;
  const isAdd = proposal.txType.equals(TxType.ADD_OWNER).toBoolean();
  const predecessor = isAdd ? contract.ownerStore.sortedPredecessor(target) : null;
  const insertAfter = predecessor
    ? new PublicKeyOption({ value: predecessor, isSome: Bool(true) })
    : PublicKeyOption.none();

  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
    await zkApp.executeOwnerChange(
      proposal,
      approvalWitness,
      approvalCount,
      contract.ownerStore.getWitness(),
      insertAfter,
    );
  });

  await submitTransaction(label, tx, [feePayer.key]);
  contract.approvalStore.setCount(proposalHash, EXECUTED_MARKER);

  if (isAdd) {
    contract.ownerStore.addSorted(target);
  } else {
    contract.ownerStore.remove(target);
  }
  contract.configNonce += 1;
}

async function executeThresholdChange(
  contract: FixtureContract,
  executor: ManagedSigner,
  proposal: TransactionProposal,
  label: string,
  feePayer: ManagedSigner = executor,
) {
  const proposalHash = proposal.hash();
  const approvalCount = contract.approvalStore.getCount(proposalHash);
  const approvalWitness = contract.approvalStore.getWitness(proposalHash);
  const zkApp = new MinaGuard(contract.zkAppAddress);

  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
    await zkApp.executeThresholdChange(
      proposal,
      approvalWitness,
      approvalCount,
      proposal.data,
    );
  });

  await submitTransaction(label, tx, [feePayer.key]);
  contract.approvalStore.setCount(proposalHash, EXECUTED_MARKER);
  contract.configNonce += 1;
  contract.threshold = Number(proposal.data.toString());
}

async function executeDelegate(
  contract: FixtureContract,
  executor: ManagedSigner,
  proposal: TransactionProposal,
  label: string,
  feePayer: ManagedSigner = executor,
) {
  const proposalHash = proposal.hash();
  const approvalCount = contract.approvalStore.getCount(proposalHash);
  const approvalWitness = contract.approvalStore.getWitness(proposalHash);
  const zkApp = new MinaGuard(contract.zkAppAddress);

  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
    await zkApp.executeDelegate(proposal, approvalWitness, approvalCount);
  });

  await submitTransaction(label, tx, [feePayer.key]);
  contract.approvalStore.setCount(proposalHash, EXECUTED_MARKER);
}

async function waitForIndexedContracts(previewBaseUrl: string, expected: Array<{ address: string; proposalCount: number }>) {
  const contractsUrl = `${previewBaseUrl}/api/contracts`;
  const statusUrl = `${previewBaseUrl}/api/indexer/status`;

  await waitForCondition('indexer to discover fixture contracts', async () => {
    const status = await fetchJson<{ discoveredContracts: number; lastError: string | null }>(statusUrl);
    if (status.lastError) {
      log(`Indexer status warning: ${status.lastError}`);
    }

    const contracts = await fetchJson<Array<{ address: string }>>(contractsUrl);
    return expected.every((item) => contracts.some((contract) => contract.address === item.address));
  });

  await waitForCondition('indexer to ingest fixture proposals', async () => {
    for (const item of expected) {
      const proposals = await fetchJson<Array<unknown>>(`${previewBaseUrl}/api/contracts/${item.address}/proposals`);
      if (proposals.length < item.proposalCount) return false;
    }
    return true;
  });
}

interface FixtureRuntimeContext {
  scenario: FixtureScenario;
  previewBaseUrl: string;
  mainAddress: string;
  mainOwner: PublicKey;
  deployer: ManagedSigner;
  signerA: ManagedSigner;
  signerB: ManagedSigner;
}

async function runFullScenario(ctx: FixtureRuntimeContext): Promise<FixtureSummary> {
  const { previewBaseUrl, mainAddress, mainOwner, deployer, signerA, signerB } = ctx;

  const transferContract = await createFixtureContract(
    'Transfers',
    deployer,
    [mainOwner, signerA.pub, signerB.pub],
    2,
    TRANSFER_CONTRACT_FUNDING,
  );
  const addOwnerContract = await createFixtureContract(
    'Add Owner',
    deployer,
    [mainOwner, signerA.pub, signerB.pub],
    2,
  );
  const removeOwnerContract = await createFixtureContract(
    'Remove Owner',
    deployer,
    [mainOwner, signerA.pub, signerB.pub],
    2,
  );
  const thresholdContract = await createFixtureContract(
    'Threshold',
    deployer,
    [mainOwner, signerA.pub, signerB.pub],
    2,
  );
  const delegateContract = await createFixtureContract(
    'Delegate',
    deployer,
    [mainOwner, signerA.pub, signerB.pub],
    2,
  );

  const executedTransfer = createTransferProposal(
    transferContract.zkAppAddress,
    transferContract.nextProposalNonce++,
    transferContract.configNonce,
    [{ address: mainOwner, amount: UInt64.from(1_250_000_000) }],
  );
  await propose(transferContract, signerA, executedTransfer, 'Transfers: propose executed transfer', deployer);
  await approve(transferContract, signerB, executedTransfer, 'Transfers: approve executed transfer', deployer);
  await executeTransfer(transferContract, signerA, executedTransfer, 'Transfers: execute transfer', deployer);

  const readyTransfer = createTransferProposal(
    transferContract.zkAppAddress,
    transferContract.nextProposalNonce++,
    transferContract.configNonce,
    [{ address: signerA.pub, amount: UInt64.from(900_000_000) }],
  );
  await propose(transferContract, signerB, readyTransfer, 'Transfers: propose ready transfer', deployer);
  await approve(transferContract, signerA, readyTransfer, 'Transfers: approve ready transfer', deployer);

  const pendingTransfer = createTransferProposal(
    transferContract.zkAppAddress,
    transferContract.nextProposalNonce++,
    transferContract.configNonce,
    [{ address: signerB.pub, amount: UInt64.from(700_000_000) }],
  );
  await propose(transferContract, signerA, pendingTransfer, 'Transfers: propose pending transfer', deployer);

  const newOwner = PrivateKey.random().toPublicKey();
  const addOwnerProposal = createAddOwnerProposal(
    addOwnerContract.zkAppAddress,
    addOwnerContract.nextProposalNonce++,
    addOwnerContract.configNonce,
    newOwner,
  );
  await propose(addOwnerContract, signerA, addOwnerProposal, 'Add Owner: propose', deployer);
  await approve(addOwnerContract, signerB, addOwnerProposal, 'Add Owner: approve', deployer);

  const removeOwnerProposal = createRemoveOwnerProposal(
    removeOwnerContract.zkAppAddress,
    removeOwnerContract.nextProposalNonce++,
    removeOwnerContract.configNonce,
    signerB.pub,
  );
  await propose(removeOwnerContract, signerA, removeOwnerProposal, 'Remove Owner: propose', deployer);
  await approve(removeOwnerContract, signerB, removeOwnerProposal, 'Remove Owner: approve', deployer);

  const thresholdProposal = createThresholdProposal(
    thresholdContract.zkAppAddress,
    thresholdContract.nextProposalNonce++,
    thresholdContract.configNonce,
    1,
  );
  await propose(thresholdContract, signerB, thresholdProposal, 'Threshold: propose', deployer);
  await approve(thresholdContract, signerA, thresholdProposal, 'Threshold: approve', deployer);

  const delegateTarget = PrivateKey.random().toPublicKey();
  const delegateProposal = createDelegateProposal(
    delegateContract.zkAppAddress,
    delegateContract.nextProposalNonce++,
    delegateContract.configNonce,
    delegateTarget,
  );
  await propose(delegateContract, signerA, delegateProposal, 'Delegate: propose', deployer);
  await approve(delegateContract, signerB, delegateProposal, 'Delegate: approve', deployer);

  await waitForIndexedContracts(previewBaseUrl, [
    { address: transferContract.zkAppAddress.toBase58(), proposalCount: 3 },
    { address: addOwnerContract.zkAppAddress.toBase58(), proposalCount: 1 },
    { address: removeOwnerContract.zkAppAddress.toBase58(), proposalCount: 1 },
    { address: thresholdContract.zkAppAddress.toBase58(), proposalCount: 1 },
    { address: delegateContract.zkAppAddress.toBase58(), proposalCount: 1 },
  ]);

  return {
    scenario: 'full',
    mainAddress,
    signers: [
      { label: signerA.label, publicKey: signerA.publicKey },
      { label: signerB.label, publicKey: signerB.publicKey },
    ],
    contracts: [
      {
        label: 'Transfers',
        address: transferContract.zkAppAddress.toBase58(),
        scenarios: [
          'proposal 1 executed',
          'proposal 2 approved and ready to execute',
          'proposal 3 proposed and needs one more approval',
        ],
      },
      {
        label: 'Add Owner',
        address: addOwnerContract.zkAppAddress.toBase58(),
        scenarios: ['proposal 1 approved and ready to execute'],
      },
      {
        label: 'Remove Owner',
        address: removeOwnerContract.zkAppAddress.toBase58(),
        scenarios: ['proposal 1 approved and ready to execute'],
      },
      {
        label: 'Threshold',
        address: thresholdContract.zkAppAddress.toBase58(),
        scenarios: ['proposal 1 approved and ready to execute'],
      },
      {
        label: 'Delegate',
        address: delegateContract.zkAppAddress.toBase58(),
        scenarios: ['proposal 1 approved and ready to execute'],
      },
    ],
  };
}

async function runMinimalScenario(ctx: FixtureRuntimeContext): Promise<FixtureSummary> {
  const { previewBaseUrl, mainAddress, mainOwner, deployer, signerA, signerB } = ctx;

  const vault1 = await createFixtureContract(
    'Vault 1',
    deployer,
    [mainOwner, signerA.pub],
    1,
    TRANSFER_CONTRACT_FUNDING,
  );
  const vault2 = await createFixtureContract(
    'Vault 2',
    deployer,
    [mainOwner, signerB.pub],
    1,
    TRANSFER_CONTRACT_FUNDING,
  );

  const vault1Transfer = createTransferProposal(
    vault1.zkAppAddress,
    vault1.nextProposalNonce++,
    vault1.configNonce,
    [{ address: mainOwner, amount: UInt64.from(350_000_000) }],
  );
  await propose(vault1, signerA, vault1Transfer, 'Vault 1: propose transfer', deployer);
  await executeTransfer(vault1, signerA, vault1Transfer, 'Vault 1: execute transfer', deployer);

  const vault1RemoveHelper = createRemoveOwnerProposal(
    vault1.zkAppAddress,
    vault1.nextProposalNonce++,
    vault1.configNonce,
    signerA.pub,
  );
  await propose(vault1, signerA, vault1RemoveHelper, 'Vault 1: propose remove helper', deployer);
  await executeOwnerChange(vault1, signerA, vault1RemoveHelper, 'Vault 1: execute remove helper', deployer);

  const vault2Transfer = createTransferProposal(
    vault2.zkAppAddress,
    vault2.nextProposalNonce++,
    vault2.configNonce,
    [{ address: mainOwner, amount: UInt64.from(420_000_000) }],
  );
  await propose(vault2, signerB, vault2Transfer, 'Vault 2: propose transfer', deployer);
  await executeTransfer(vault2, signerB, vault2Transfer, 'Vault 2: execute transfer', deployer);

  const vault2RemoveHelper = createRemoveOwnerProposal(
    vault2.zkAppAddress,
    vault2.nextProposalNonce++,
    vault2.configNonce,
    signerB.pub,
  );
  await propose(vault2, signerB, vault2RemoveHelper, 'Vault 2: propose remove helper', deployer);
  await executeOwnerChange(vault2, signerB, vault2RemoveHelper, 'Vault 2: execute remove helper', deployer);

  await waitForIndexedContracts(previewBaseUrl, [
    { address: vault1.zkAppAddress.toBase58(), proposalCount: 2 },
    { address: vault2.zkAppAddress.toBase58(), proposalCount: 2 },
  ]);

  return {
    scenario: 'minimal',
    mainAddress,
    signers: [
      { label: signerA.label, publicKey: signerA.publicKey },
      { label: signerB.label, publicKey: signerB.publicKey },
    ],
    contracts: [
      {
        label: 'Vault 1',
        address: vault1.zkAppAddress.toBase58(),
        scenarios: [
          'proposal 1 executed transfer to the main address',
          'proposal 2 executed removal of the helper signer',
          'main address is now the lone owner with threshold 1',
        ],
      },
      {
        label: 'Vault 2',
        address: vault2.zkAppAddress.toBase58(),
        scenarios: [
          'proposal 1 executed transfer to the main address',
          'proposal 2 executed removal of the helper signer',
          'main address is now the lone owner with threshold 1',
        ],
      },
    ],
  };
}

export async function runLightnetFixture(options: LightnetFixtureOptions): Promise<void> {
  const scenario = normalizeScenario(options.scenario);
  const previewBaseUrl = normalizeBaseUrl(options.previewBaseUrl);
  const mainOwner = PublicKey.fromBase58(options.mainAddress);
  const minaEndpoint = `${previewBaseUrl}/graphql`;
  const archiveEndpoint = `${previewBaseUrl}/archive`;
  const accountManagerUrl = `${previewBaseUrl}/accounts`;
  const healthUrl = `${previewBaseUrl}/health`;

  await waitForCondition('preview health', async () => {
    try {
      const response = await fetch(healthUrl, { cache: 'no-store' });
      return response.ok;
    } catch {
      return false;
    }
  }, 120_000, 2_000);

  log(`Using fixture scenario: ${scenario}`);
  log('Configuring o1js network (proofs disabled)');
  const network = Mina.Network({
    networkId: 'testnet',
    mina: minaEndpoint,
    archive: archiveEndpoint,
  });
  network.proofsEnabled = false;
  Mina.setActiveInstance(network);

  log('Compiling MinaGuard once for all fixture transactions');
  await MinaGuard.compile();

  log('Acquiring funded lightnet deployer account');
  const deployer = await acquireLightnetAccount(accountManagerUrl, 'deployer');

  log('Generating local signer accounts');
  const signerA = generateSigner('signer-a');
  const signerB = generateSigner('signer-b');

  log(`Deployer: ${deployer.publicKey}`);
  log(`Signer A: ${signerA.publicKey}`);
  log(`Signer B: ${signerB.publicKey}`);
  log(`Main owner: ${options.mainAddress}`);

  await maybeFundNewAccount(deployer, mainOwner, MAIN_ACCOUNT_FUNDING, 'fund main owner');

  const ctx: FixtureRuntimeContext = {
    scenario,
    previewBaseUrl,
    mainAddress: options.mainAddress,
    mainOwner,
    deployer,
    signerA,
    signerB,
  };

  const summary = scenario === 'full'
    ? await runFullScenario(ctx)
    : await runMinimalScenario(ctx);

  console.log('');
  console.log(JSON.stringify(summary, null, 2));
}
