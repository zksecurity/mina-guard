// ---------------------------------------------------------------------------
// Core transaction building logic for the offline CLI.
//
// This mirrors the web worker's (multisigClient.worker.ts) transaction
// building flow almost 1:1. The key differences:
//
//   - Account data: worker fetches live from the network; CLI injects
//     bundled snapshots via addCachedAccount.
//   - Signing: worker delegates to Auro wallet; CLI uses mina-signer.
//   - Network: worker connects to a real Mina node; CLI uses a dummy
//     endpoint with a patched getNetworkState.
//   - Merkle stores: worker maintains them in memory across operations;
//     CLI rebuilds from events in the JSON bundle file each time.
//
// The contract calls and proof generation are identical. A future
// refactor could move the proof to the browser (2-trip flow), which
// would reduce the CLI to just mina-signer signing calls.
// ---------------------------------------------------------------------------

import {
  Mina,
  Field,
  UInt64,
  UInt32,
  AccountUpdate,
  PublicKey,
  PrivateKey,
  Signature,
  Bool,
  Cache,
  MerkleMap,
  Poseidon,
  addCachedAccount,
  TokenId,
} from 'o1js';

// @ts-ignore — ESM bundle built by ui/package.json postinstall
import Client from '../../ui/deps/o1js/src/mina-signer/dist/web/index.js';

import {
  MinaGuard,
  Receiver,
  TransactionProposal,
  SetupOwnersInput,
  EXECUTED_MARKER,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
  OwnerStore,
  VoteNullifierStore,
  ApprovalStore,
  PublicKeyOption,
  Destination,
  memoToField,
} from 'contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Must match the fee used by the web worker. */
const ZKAPP_TX_FEE = 0.1e9; // 0.1 MINA in nanomina

const EMPTY_PUBKEY_B58 = 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG';

// ---------------------------------------------------------------------------
// Bundle types
// ---------------------------------------------------------------------------

/** Receiver entry in a proposal. */
interface BundleReceiver {
  address: string;
  amount: string;
}

interface BundleAccount {
  publicKey: string;
  token: string;
  nonce: string;
  balance: { total: string };
  tokenSymbol: string | null;
  receiptChainHash: string | null;
  timing: {
    initialMinimumBalance: string | null;
    cliffTime: string | null;
    cliffAmount: string | null;
    vestingPeriod: string | null;
    vestingIncrement: string | null;
  };
  permissions: Record<string, unknown> | null;
  delegateAccount: { publicKey: string } | null;
  votingFor: string | null;
  zkappState: string[] | null;
  verificationKey: { verificationKey: string; hash: string } | null;
  actionState: string[] | null;
  provedState: boolean | null;
  zkappUri: string | null;
}

/** Fields common to all bundle actions. */
interface BundleBase {
  version: 1;
  minaNetwork: 'testnet' | 'mainnet';
  contractAddress: string;
  feePayerAddress: string;
  accounts: Record<string, BundleAccount>;
  events: Array<{ eventType: string; payload: unknown }>;
}

export interface OfflineProposeBundle extends BundleBase {
  action: 'propose';
  input: {
    txType: string;
    nonce: number;
    receivers?: BundleReceiver[];
    newOwner?: string;
    removeOwnerAddress?: string;
    newThreshold?: number;
    delegate?: string;
    undelegate?: boolean;
    reclaimAmount?: string;
    childAccount?: string;
    childMultiSigEnable?: boolean;
    createChildConfigHash?: string;
    expirySlot?: number;
    childPrivateKey?: string;
    childOwners?: string[];
    childThreshold?: number;
  };
  configNonce: number;
  networkId: string;
}

export interface OfflineApproveBundle extends BundleBase {
  action: 'approve';
  proposal: BundleProposal;
}

export interface OfflineExecuteBundle extends BundleBase {
  action: 'execute';
  proposal: BundleProposal;
  receiverAccountExists: Record<string, boolean>;
  childAddress?: string;
  childEvents?: Array<{ eventType: string; payload: unknown }>;
  childOwners?: string[];
  childThreshold?: number;
}

export type OfflineBundle = OfflineProposeBundle | OfflineApproveBundle | OfflineExecuteBundle;

interface BundleProposal {
  proposalHash: string;
  proposer: string | null;
  toAddress: string | null;
  tokenId: string | null;
  txType: string | null;
  data: string | null;
  nonce: string | null;
  configNonce: string | null;
  expirySlot: string | null;
  networkId: string | null;
  guardAddress: string | null;
  destination: string | null;
  childAccount: string | null;
  memoHash: string | null;
  receivers: BundleReceiver[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// NewProposalInput — mirrors the UI type to avoid importing from ui/
// ---------------------------------------------------------------------------

interface NewProposalInput {
  txType: string;
  nonce: number;
  receivers?: BundleReceiver[];
  newOwner?: string;
  removeOwnerAddress?: string;
  newThreshold?: number;
  delegate?: string;
  undelegate?: boolean;
  expirySlot?: number;
  childAccount?: string;
  reclaimAmount?: string;
  childMultiSigEnable?: boolean;
  createChildConfigHash?: string;
  childPrivateKey?: string;
  childOwners?: string[];
  childThreshold?: number;
  memo?: string;
}

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface SignedTxOutput {
  version: 1;
  type: 'offline-signed-tx';
  action: 'propose' | 'approve' | 'execute';
  contractAddress: string;
  proposalHash: string;
  transaction: unknown;
}

// ---------------------------------------------------------------------------
// Logging helper type
// ---------------------------------------------------------------------------

type LogFn = (msg: string) => void;

// ---------------------------------------------------------------------------
// TxType helpers (duplicated from worker to stay self-contained)
// ---------------------------------------------------------------------------

type TxType =
  | 'transfer'
  | 'addOwner'
  | 'removeOwner'
  | 'changeThreshold'
  | 'setDelegate'
  | 'createChild'
  | 'allocateChild'
  | 'reclaimChild'
  | 'destroyChild'
  | 'enableChildMultiSig';

const TX_TYPE_NAME_SET: ReadonlySet<string> = new Set([
  'transfer', 'addOwner', 'removeOwner', 'changeThreshold', 'setDelegate',
  'createChild', 'allocateChild', 'reclaimChild', 'destroyChild', 'enableChildMultiSig',
]);

function normalizeTxType(value: string | null | undefined): TxType | null {
  if (!value) return null;
  if (TX_TYPE_NAME_SET.has(value)) return value as TxType;
  // Numeric form
  switch (value) {
    case '0': return 'transfer';
    case '1': return 'addOwner';
    case '2': return 'removeOwner';
    case '3': return 'changeThreshold';
    case '4': return 'setDelegate';
    case '5': return 'createChild';
    case '6': return 'allocateChild';
    case '7': return 'reclaimChild';
    case '8': return 'destroyChild';
    case '9': return 'enableChildMultiSig';
    default: return null;
  }
}

function uiTxTypeToField(type: string): InstanceType<typeof Field> {
  if (type === 'transfer') return Field(0);
  if (type === 'addOwner') return Field(1);
  if (type === 'removeOwner') return Field(2);
  if (type === 'changeThreshold') return Field(3);
  if (type === 'setDelegate') return Field(4);
  if (type === 'createChild') return Field(5);
  if (type === 'allocateChild') return Field(6);
  if (type === 'reclaimChild') return Field(7);
  if (type === 'destroyChild') return Field(8);
  if (type === 'enableChildMultiSig') return Field(9);
  throw new Error(`Unknown TxType: ${type}`);
}

const CHILD_LIFECYCLE_TYPES = new Set(['reclaimChild', 'destroyChild', 'enableChildMultiSig']);

// ---------------------------------------------------------------------------
// Proposal building helpers (duplicated from worker)
// ---------------------------------------------------------------------------

function safePublicKey(base58: string | null | undefined): InstanceType<typeof PublicKey> {
  if (!base58) return PublicKey.empty();
  try {
    return PublicKey.fromBase58(base58);
  } catch {
    return PublicKey.empty();
  }
}

function governanceTargetAddress(input: NewProposalInput): string | null {
  if (input.txType === 'addOwner') return input.newOwner ?? null;
  if (input.txType === 'removeOwner') return input.removeOwnerAddress ?? null;
  if (input.txType === 'setDelegate' && !input.undelegate) return input.delegate ?? null;
  return null;
}

function buildTransferReceivers(
  receivers: BundleReceiver[],
): InstanceType<typeof Receiver>[] {
  const normalized = receivers.map((r) => new Receiver({
    address: r.address === EMPTY_PUBKEY_B58
      ? PublicKey.empty()
      : PublicKey.fromBase58(r.address),
    amount: UInt64.from(r.amount),
  }));

  while (normalized.length < MAX_RECEIVERS) {
    normalized.push(Receiver.empty());
  }
  return normalized.slice(0, MAX_RECEIVERS);
}

function buildReceiversForProposal(input: NewProposalInput): InstanceType<typeof Receiver>[] {
  if (input.txType === 'transfer' || input.txType === 'allocateChild') {
    return buildTransferReceivers(input.receivers ?? []);
  }
  const arr = Array.from({ length: MAX_RECEIVERS }, () => Receiver.empty());
  const target = governanceTargetAddress(input);
  if (target) {
    arr[0] = new Receiver({ address: PublicKey.fromBase58(target), amount: UInt64.from(0) });
  }
  return arr;
}

function buildProposalDataField(input: NewProposalInput): InstanceType<typeof Field> {
  if (input.txType === 'changeThreshold') return Field(input.newThreshold ?? 0);
  if (input.txType === 'reclaimChild') return Field(input.reclaimAmount ?? '0');
  if (input.txType === 'enableChildMultiSig') return Field(input.childMultiSigEnable ? 1 : 0);
  if (input.txType === 'createChild') return Field(input.createChildConfigHash ?? '0');
  return Field(0);
}

function buildProposalStruct(
  proposal: BundleProposal,
  fallbackGuardAddress: string,
): InstanceType<typeof TransactionProposal> {
  const txType = normalizeTxType(proposal.txType);
  const destination = proposal.destination === 'remote' ? Destination.REMOTE : Destination.LOCAL;
  const childAccount = proposal.childAccount
    ? safePublicKey(proposal.childAccount)
    : PublicKey.empty();
  return new TransactionProposal({
    receivers: buildTransferReceivers(proposal.receivers),
    tokenId: Field(proposal.tokenId ?? '0'),
    txType: txType ? uiTxTypeToField(txType) : Field(0),
    data: Field(proposal.data ?? '0'),
    nonce: Field(proposal.nonce ?? '0'),
    configNonce: Field(proposal.configNonce ?? '0'),
    expirySlot: Field(proposal.expirySlot ?? '0'),
    networkId: Field(proposal.networkId ?? '0'),
    guardAddress: safePublicKey(proposal.guardAddress ?? fallbackGuardAddress),
    destination,
    childAccount,
    memoHash: Field(proposal.memoHash ?? '0'),
  });
}

// ---------------------------------------------------------------------------
// Store rebuilding from bundled events
// ---------------------------------------------------------------------------

function rebuildStores(events: Array<{ eventType: string; payload: unknown }>) {
  const ownerStore = new OwnerStore();
  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();

  const emptyKey = PublicKey.empty().toBase58();
  const setupOwnerEntries = events
    .filter((e) => e.eventType === 'setupOwner')
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return { owner: p.owner };
    })
    .filter(({ owner }) => typeof owner === 'string' && (owner as string).length > 10 && owner !== emptyKey)
    .sort((a, b) => ((a.owner as string) > (b.owner as string) ? 1 : -1));
  for (const { owner } of setupOwnerEntries) {
    ownerStore.addSorted(PublicKey.fromBase58(owner as string));
  }

  for (const event of events) {
    if (event.eventType === 'setupOwner') continue;

    if (event.eventType === 'ownerChange' || event.eventType === 'ownerChangeBatch') {
      const payload = event.payload as Record<string, unknown>;
      const owner = payload.owner;
      const added = payload.added;
      if (typeof owner === 'string' && owner.length > 10) {
        if (added === '1' || added === 1 || added === true) {
          ownerStore.addSorted(PublicKey.fromBase58(owner));
        } else {
          ownerStore.remove(PublicKey.fromBase58(owner));
        }
      }
      continue;
    }

    if (event.eventType === 'proposal') {
      const payload = event.payload as Record<string, unknown>;
      const proposalHash = payload.proposalHash;
      const proposer = payload.proposer;
      if (typeof proposalHash === 'string') {
        const key = Field(proposalHash);
        const proposeCount = PROPOSED_MARKER.add(1);
        if (proposeCount.toBigInt() > approvalStore.getCount(key).toBigInt()) {
          approvalStore.setCount(key, proposeCount);
        }
      }
      if (
        typeof proposalHash === 'string' &&
        typeof proposer === 'string' &&
        proposer.length > 10
      ) {
        nullifierStore.nullify(Field(proposalHash), PublicKey.fromBase58(proposer));
      }
      continue;
    }

    if (event.eventType === 'approval') {
      const payload = event.payload as Record<string, unknown>;
      const proposalHash = payload.proposalHash;
      const approver = payload.approver;
      const approvalCount = payload.approvalCount;
      if (typeof proposalHash === 'string' && typeof approvalCount === 'string') {
        const key = Field(proposalHash);
        const newCount = Field(approvalCount);
        const existing = approvalStore.getCount(key);
        if (newCount.toBigInt() > existing.toBigInt()) {
          approvalStore.setCount(key, newCount);
        }
      }
      if (
        typeof proposalHash === 'string' &&
        typeof approver === 'string' &&
        approver.length > 10
      ) {
        nullifierStore.nullify(Field(proposalHash), PublicKey.fromBase58(approver));
      }
      continue;
    }

    if (event.eventType === 'execution' || event.eventType === 'executionBatch') {
      const payload = event.payload as Record<string, unknown>;
      const proposalHash = payload.proposalHash;
      const txType = payload.txType;
      const isRemoteExecution =
        typeof txType === 'string' && (txType === '5' || txType === '7' || txType === '8' || txType === '9');
      if (typeof proposalHash === 'string' && !isRemoteExecution) {
        approvalStore.setCount(Field(proposalHash), EXECUTED_MARKER);
      }
    }
  }

  return { ownerStore, approvalStore, nullifierStore };
}

function rebuildChildExecutionMap(childEvents: Array<{ eventType: string; payload: unknown }>): InstanceType<typeof MerkleMap> {
  const map = new MerkleMap();
  const remoteExecutionTypes = new Set(['7', '8', '9']);
  for (const event of childEvents) {
    if (event.eventType !== 'execution' && event.eventType !== 'executionBatch') continue;
    const payload = event.payload as Record<string, unknown>;
    const proposalHash = payload.proposalHash;
    const txType = payload.txType;
    if (typeof proposalHash !== 'string') continue;
    if (typeof txType !== 'string' || !remoteExecutionTypes.has(txType)) continue;
    map.set(Field(proposalHash), EXECUTED_MARKER);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Network + account injection
// ---------------------------------------------------------------------------

function configureNetwork(bundle: BundleBase) {
  const network = Mina.Network({
    networkId: bundle.minaNetwork === 'mainnet' ? 'mainnet' : 'testnet',
    mina: 'http://localhost:0',
    archive: 'http://localhost:0',
  });
  if (skipProofs) network.proofsEnabled = false;

  // The CLI uses a dummy endpoint so fetchMissingData can never populate
  // the network cache.  Override getNetworkState to return defaults instead
  // of throwing — network preconditions (e.g. blockchainLength) are still
  // set on the transaction but won't be validated until broadcast.
  const origGetNetworkState = network.getNetworkState.bind(network);
  network.getNetworkState = () => {
    try {
      return origGetNetworkState();
    } catch {
      const epochData = {
        ledger: { hash: Field(0), totalCurrency: UInt64.zero },
        seed: Field(0),
        startCheckpoint: Field(0),
        lockCheckpoint: Field(0),
        epochLength: UInt32.zero,
      };
      return {
        snarkedLedgerHash: Field(0),
        blockchainLength: UInt32.zero,
        minWindowDensity: UInt32.zero,
        totalCurrency: UInt64.zero,
        globalSlotSinceGenesis: UInt32.zero,
        stakingEpochData: epochData,
        nextEpochData: { ...epochData },
      };
    }
  };

  Mina.setActiveInstance(network);
}

/**
 * Injects all account snapshots from the bundle into the o1js account cache.
 *
 * Bundles store accounts in GraphQL-compatible format (FetchedAccount shape):
 *   { publicKey: string, nonce: string, balance: { total: string }, zkappState: string[], ... }
 *
 * We deserialize to PartialAccount with o1js types and inject via addCachedAccount.
 */
function injectAccounts(bundle: BundleBase) {
  for (const [address, acct] of Object.entries(bundle.accounts)) {
    if (!acct) continue;
    try {
      const partial: Parameters<typeof addCachedAccount>[0] = {
        publicKey: PublicKey.fromBase58(address),
        tokenId: acct.token ? TokenId.fromBase58(acct.token) : TokenId.default,
        nonce: UInt32.from(acct.nonce),
        balance: UInt64.from(acct.balance.total),
      };
      if (acct.zkappState) {
        const zkapp: NonNullable<typeof partial.zkapp> = {
          appState: acct.zkappState.map((s) => Field(s)),
        };
        if (acct.verificationKey) {
          zkapp.verificationKey = {
            data: acct.verificationKey.verificationKey,
            hash: Field(acct.verificationKey.hash),
          };
        }
        partial.zkapp = zkapp;
      }
      addCachedAccount(partial);
    } catch (err) {
      process.stderr.write(`[offline-cli] Warning: could not inject account ${address}: ${err}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fee payer signing with mina-signer
// ---------------------------------------------------------------------------

function signFeePayer(txJson: string, privateKey: string, network: 'testnet' | 'mainnet'): string {
  const client = new Client({ network });
  const parsed = typeof txJson === 'string' ? JSON.parse(txJson) : txJson;
  const wrapped = { feePayer: parsed.feePayer, zkappCommand: parsed };
  const { fullCommitment } = client.getZkappCommandCommitmentsNoCheck(wrapped);
  const signed = client.signFields([BigInt(fullCommitment)], privateKey);
  parsed.feePayer.authorization = signed.signature;

  // Also sign any account updates owned by the fee payer that require a signature
  const feePayerPk = parsed.feePayer.body.publicKey;
  for (const update of parsed.accountUpdates ?? []) {
    if (
      update.body?.publicKey === feePayerPk &&
      update.body?.authorizationKind?.isSigned === true &&
      update.body?.useFullCommitment === true
    ) {
      update.authorization = { signature: signed.signature };
    }
  }

  return JSON.stringify(parsed);
}

/** Signs a child zkApp's deploy account update using its private key. */
function signChildAccount(txJson: string, childKey: InstanceType<typeof PrivateKey>, network: 'testnet' | 'mainnet'): string {
  const parsed = JSON.parse(txJson);
  const childPk = childKey.toPublicKey().toBase58();
  const client = new Client({ network });
  const wrapped = { feePayer: parsed.feePayer, zkappCommand: parsed };
  const { fullCommitment } = client.getZkappCommandCommitmentsNoCheck(wrapped);
  const signed = client.signFields([BigInt(fullCommitment)], childKey.toBase58());
  for (const update of parsed.accountUpdates ?? []) {
    if (
      update.body?.publicKey === childPk &&
      update.body?.authorizationKind?.isSigned === true &&
      update.body?.useFullCommitment === true
    ) {
      update.authorization = { signature: signed.signature };
    }
  }
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Transaction sender helper
// ---------------------------------------------------------------------------

function txSender(pub: InstanceType<typeof PublicKey>) {
  return { sender: pub, fee: ZKAPP_TX_FEE };
}

/** Safely serializes tx.toJSON() regardless of whether it returns a string or object. */
function serializeTx(tx: Awaited<ReturnType<typeof Mina.transaction>>): string {
  const json = tx.toJSON();
  return typeof json === 'string' ? json : JSON.stringify(json);
}

// ---------------------------------------------------------------------------
// Compile (with filesystem cache)
// ---------------------------------------------------------------------------

let compiled = false;
const skipProofs = process.env.SKIP_PROOFS === '1';

async function compileContract(log: LogFn) {
  if (compiled || skipProofs) return;
  log('Compiling MinaGuard contract (this may take a few minutes on first run)...');
  const t0 = performance.now();
  await MinaGuard.compile({ cache: Cache.FileSystem('./cache') });
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  log(`Compilation done in ${elapsed}s`);
  compiled = true;
}

async function maybeProve(tx: Awaited<ReturnType<typeof Mina.transaction>>) {
  if (skipProofs) {
    for (const au of (tx as any).transaction.accountUpdates) {
      if (au.lazyAuthorization?.kind === 'lazy-proof') {
        au.authorization = { proof: 'dummy' };
        au.lazyAuthorization = undefined;
      }
    }
    return;
  }
  await tx.prove();
}

// ---------------------------------------------------------------------------
// Handler: propose
// ---------------------------------------------------------------------------

export async function handlePropose(
  bundle: OfflineProposeBundle,
  privateKey: string,
  log: LogFn,
): Promise<SignedTxOutput> {
  const input = bundle.input as NewProposalInput;
  const isCreateChild = input.txType === 'createChild';

  if (isCreateChild && (!input.childPrivateKey || !input.childOwners || input.childThreshold == null)) {
    throw new Error('createChild proposal requires childPrivateKey, childOwners, and childThreshold in the bundle');
  }

  log('Configuring network and injecting accounts...');
  configureNetwork(bundle);
  injectAccounts(bundle);

  await compileContract(log);

  log('Rebuilding Merkle stores from events...');
  const { ownerStore, approvalStore, nullifierStore } = rebuildStores(bundle.events);

  // Build proposal struct
  const receivers = buildReceiversForProposal(input);
  const txType = uiTxTypeToField(input.txType);
  const data = buildProposalDataField(input);

  const isRemote =
    isCreateChild ||
    input.txType === 'reclaimChild' ||
    input.txType === 'destroyChild' ||
    input.txType === 'enableChildMultiSig';

  const proposal = new TransactionProposal({
    receivers,
    tokenId: Field(0),
    txType,
    data,
    nonce: Field(input.nonce),
    configNonce: Field(bundle.configNonce),
    expirySlot: Field(input.expirySlot ?? 0),
    networkId: Field(bundle.networkId),
    guardAddress: PublicKey.fromBase58(bundle.contractAddress),
    destination: isRemote ? Destination.REMOTE : Destination.LOCAL,
    childAccount: input.childAccount
      ? PublicKey.fromBase58(input.childAccount)
      : PublicKey.empty(),
    memoHash: memoToField(input.memo ?? ''),
  });

  const proposalHash = proposal.hash();
  const hashStr = proposalHash.toString();
  log(`Proposal hash: ${hashStr}`);

  // Sign the proposal hash with mina-signer
  log('Signing proposal hash...');
  const client = new Client({ network: bundle.minaNetwork });
  const signedFields = client.signFields([BigInt(hashStr)], privateKey);
  const signature = Signature.fromBase58(String(signedFields.signature));

  // Get witnesses
  const proposer = PublicKey.fromBase58(bundle.feePayerAddress);
  const ownerWitness = ownerStore.getWitness();
  const nullifierWitness = nullifierStore.getWitness(proposalHash, proposer);
  const approvalWitness = approvalStore.getWitness(proposalHash);

  // Prepare child deployment data for CREATE_CHILD
  let childKey: InstanceType<typeof PrivateKey> | null = null;
  let childOwnerStore: InstanceType<typeof OwnerStore> | null = null;
  let childPaddedOwners: InstanceType<typeof PublicKey>[] | null = null;
  if (isCreateChild) {
    if (!input.childPrivateKey || !input.childOwners || input.childThreshold == null) {
      throw new Error('createChild proposal requires childPrivateKey, childOwners, and childThreshold in the bundle');
    }
    childKey = PrivateKey.fromBase58(input.childPrivateKey);
    childOwnerStore = new OwnerStore();
    for (const addr of input.childOwners) childOwnerStore.addSorted(PublicKey.fromBase58(addr));
    childPaddedOwners = [...childOwnerStore.owners];
    while (childPaddedOwners.length < MAX_OWNERS) childPaddedOwners.push(PublicKey.empty());
  }

  // Build transaction
  log('Building transaction...');
  const contractAddress = PublicKey.fromBase58(bundle.contractAddress);
  const contract = new MinaGuard(contractAddress);

  const tx = await Mina.transaction(txSender(proposer), async () => {
    if (isCreateChild && childKey) {
      const childAddress = childKey.toPublicKey();
      const childZkApp = new MinaGuard(childAddress);
      AccountUpdate.fundNewAccount(proposer);
      await childZkApp.deploy();
    }

    await contract.propose(
      proposal,
      ownerWitness,
      proposer,
      signature,
      nullifierWitness,
      approvalWitness,
    );

    if (isCreateChild && childOwnerStore && childPaddedOwners) {
      await contract.announceChildConfig(
        proposalHash,
        proposal.childAccount,
        childOwnerStore.getCommitment(),
        Field(input.childThreshold!),
        Field(input.childOwners!.length),
        new SetupOwnersInput({ owners: childPaddedOwners.slice(0, MAX_OWNERS) }),
        ownerWitness,
        proposer,
        signature,
      );
    }
  });

  // Prove
  log('Generating zero-knowledge proof (this will take a while)...');
  const t0 = performance.now();
  await maybeProve(tx);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  log(`Proof generated in ${elapsed}s`);

  // Sign fee payer (and child key for CREATE_CHILD deploy)
  log('Signing fee payer...');
  let signedTxJson = signFeePayer(serializeTx(tx), privateKey, bundle.minaNetwork);
  if (childKey) {
    signedTxJson = signChildAccount(signedTxJson, childKey, bundle.minaNetwork);
  }

  return {
    version: 1,
    type: 'offline-signed-tx',
    action: 'propose',
    contractAddress: bundle.contractAddress,
    proposalHash: hashStr,
    transaction: JSON.parse(signedTxJson),
  };
}

// ---------------------------------------------------------------------------
// Handler: approve
// ---------------------------------------------------------------------------

export async function handleApprove(
  bundle: OfflineApproveBundle,
  privateKey: string,
  log: LogFn,
): Promise<SignedTxOutput> {
  log('Configuring network and injecting accounts...');
  configureNetwork(bundle);
  injectAccounts(bundle);

  await compileContract(log);

  log('Rebuilding Merkle stores from events...');
  const { ownerStore, approvalStore, nullifierStore } = rebuildStores(bundle.events);

  // Build proposal struct
  const proposalStruct = buildProposalStruct(
    {
      ...bundle.proposal,
      guardAddress: bundle.proposal.guardAddress ?? bundle.contractAddress,
    },
    bundle.contractAddress,
  );

  const proposalHash = proposalStruct.hash();
  const hashStr = proposalHash.toString();
  log(`Proposal hash: ${hashStr}`);

  // Sign the proposal hash
  log('Signing proposal hash...');
  const client = new Client({ network: bundle.minaNetwork });
  const signedFields = client.signFields([BigInt(hashStr)], privateKey);
  const signature = Signature.fromBase58(String(signedFields.signature));

  // Get witnesses
  const approver = PublicKey.fromBase58(bundle.feePayerAddress);
  const ownerWitness = ownerStore.getWitness();
  const approvalWitness = approvalStore.getWitness(proposalHash);
  const nullifierWitness = nullifierStore.getWitness(proposalHash, approver);
  const currentApprovalCount = approvalStore.getCount(proposalHash);

  // Build transaction
  log('Building transaction...');
  const contract = new MinaGuard(PublicKey.fromBase58(bundle.contractAddress));

  const tx = await Mina.transaction(txSender(approver), async () => {
    await contract.approveProposal(
      proposalStruct,
      signature,
      approver,
      ownerWitness,
      approvalWitness,
      currentApprovalCount,
      nullifierWitness,
    );
  });

  // Prove
  log('Generating zero-knowledge proof (this will take a while)...');
  const t0 = performance.now();
  await maybeProve(tx);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  log(`Proof generated in ${elapsed}s`);

  // Sign fee payer
  log('Signing fee payer...');
  const signedTxJson = signFeePayer(serializeTx(tx), privateKey, bundle.minaNetwork);

  return {
    version: 1,
    type: 'offline-signed-tx',
    action: 'approve',
    contractAddress: bundle.contractAddress,
    proposalHash: hashStr,
    transaction: JSON.parse(signedTxJson),
  };
}

// ---------------------------------------------------------------------------
// Handler: execute
// ---------------------------------------------------------------------------

export async function handleExecute(
  bundle: OfflineExecuteBundle,
  privateKey: string,
  log: LogFn,
): Promise<SignedTxOutput> {
  const txType = normalizeTxType(bundle.proposal.txType);
  const isCreateChild = txType === 'createChild';
  const isChildLifecycle = txType != null && CHILD_LIFECYCLE_TYPES.has(txType);

  log('Configuring network and injecting accounts...');
  configureNetwork(bundle);
  injectAccounts(bundle);

  await compileContract(log);

  log('Rebuilding Merkle stores from events...');
  const { ownerStore, approvalStore } = rebuildStores(bundle.events);

  // Build proposal struct
  const proposalStruct = buildProposalStruct(
    {
      ...bundle.proposal,
      guardAddress: bundle.proposal.guardAddress ?? bundle.contractAddress,
      ...((isChildLifecycle || isCreateChild) ? {
        destination: 'remote',
        childAccount: bundle.proposal.childAccount ?? bundle.childAddress ?? null,
      } : {}),
    },
    bundle.contractAddress,
  );

  const proposalHash = proposalStruct.hash();
  const hashStr = proposalHash.toString();
  log(`Proposal hash: ${hashStr}`);

  const approvalWitness = approvalStore.getWitness(proposalHash);
  const approvalCount = approvalStore.getCount(proposalHash);

  const executor = PublicKey.fromBase58(bundle.feePayerAddress);

  if (isCreateChild) {
    const childAddr = bundle.childAddress ?? bundle.proposal.childAccount;
    if (!childAddr) throw new Error('createChild execute bundle missing childAddress');
    if (!bundle.childOwners || bundle.childThreshold == null) {
      throw new Error('createChild execute bundle missing childOwners/childThreshold');
    }

    const childOwnerStore = new OwnerStore();
    for (const addr of bundle.childOwners) childOwnerStore.addSorted(PublicKey.fromBase58(addr));
    const paddedOwners = [...childOwnerStore.owners];
    while (paddedOwners.length < MAX_OWNERS) paddedOwners.push(PublicKey.empty());

    const expectedData = Poseidon.hash([
      childOwnerStore.getCommitment(),
      Field(bundle.childThreshold!),
      Field(bundle.childOwners!.length),
    ]);
    if (expectedData.toString() !== (bundle.proposal.data ?? '0')) {
      throw new Error(
        'SubVault config mismatch: announced owners/threshold do not match the proposal data hash. ' +
        'The bundle may contain tampered SubVault config.',
      );
    }

    const childAccount = bundle.accounts[childAddr];
    if (!childAccount) {
      throw new Error(`Bundle missing account snapshot for child address ${childAddr}`);
    }
    const childOwnersCommitment = childAccount.zkappState?.[0];
    if (childOwnersCommitment && childOwnersCommitment !== '0') {
      throw new Error(
        'This SubVault has already been initialized by another party. ' +
        'The address may have been hijacked — create a new SubVault with a fresh address.',
      );
    }

    const childZkApp = new MinaGuard(PublicKey.fromBase58(childAddr));

    log('Building transaction...');
    const tx = await Mina.transaction(txSender(executor), async () => {
      await childZkApp.executeSetupChild(
        childOwnerStore.getCommitment(),
        Field(bundle.childThreshold!),
        Field(bundle.childOwners!.length),
        new SetupOwnersInput({ owners: paddedOwners.slice(0, MAX_OWNERS) }),
        proposalStruct,
        approvalWitness,
        approvalCount,
      );
    });

    log('Generating zero-knowledge proof (this will take a while)...');
    const t0 = performance.now();
    await maybeProve(tx);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    log(`Proof generated in ${elapsed}s`);

    log('Signing fee payer...');
    const signedTxJson = signFeePayer(serializeTx(tx), privateKey, bundle.minaNetwork);

    return {
      version: 1,
      type: 'offline-signed-tx',
      action: 'execute',
      contractAddress: bundle.contractAddress,
      proposalHash: hashStr,
      transaction: JSON.parse(signedTxJson),
    };
  }

  if (isChildLifecycle) {
    const childAddr = bundle.childAddress ?? bundle.proposal.childAccount;
    if (!childAddr) throw new Error('Child lifecycle bundle missing childAddress');
    if (!bundle.childEvents) throw new Error('Child lifecycle bundle missing childEvents');

    log('Rebuilding child execution map...');
    const childExecutionMap = rebuildChildExecutionMap(bundle.childEvents);
    const childExecutionWitness = childExecutionMap.getWitness(proposalHash);

    const childZkApp = new MinaGuard(PublicKey.fromBase58(childAddr));

    log('Building transaction...');
    const tx = await Mina.transaction(txSender(executor), async () => {
      if (txType === 'reclaimChild') {
        const amount = UInt64.from(bundle.proposal.data ?? '0');
        await childZkApp.executeReclaimToParent(
          proposalStruct, approvalWitness, approvalCount, childExecutionWitness, amount,
        );
        return;
      }
      if (txType === 'destroyChild') {
        await childZkApp.executeDestroy(
          proposalStruct, approvalWitness, approvalCount, childExecutionWitness,
        );
        return;
      }
      // enableChildMultiSig
      const enabled = Field(bundle.proposal.data ?? '0');
      await childZkApp.executeEnableChildMultiSig(
        proposalStruct, approvalWitness, approvalCount, childExecutionWitness, enabled,
      );
    });

    log('Generating zero-knowledge proof (this will take a while)...');
    const t0 = performance.now();
    await maybeProve(tx);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    log(`Proof generated in ${elapsed}s`);

    log('Signing fee payer...');
    const signedTxJson = signFeePayer(serializeTx(tx), privateKey, bundle.minaNetwork);

    return {
      version: 1,
      type: 'offline-signed-tx',
      action: 'execute',
      contractAddress: bundle.contractAddress,
      proposalHash: hashStr,
      transaction: JSON.parse(signedTxJson),
    };
  }

  // -- Local execution (transfer, governance, allocate, delegate) --

  // Count new accounts for fundNewAccount
  let newAccountCount = 0;
  if (txType === 'transfer' || txType === 'allocateChild') {
    for (const r of bundle.proposal.receivers ?? []) {
      if (!r.address || r.address === EMPTY_PUBKEY_B58) continue;
      if (bundle.receiverAccountExists[r.address] === false) {
        newAccountCount += 1;
      }
    }
    if (newAccountCount > 0) {
      log(`${newAccountCount} new account(s) will be funded`);
    }
  }

  log('Building transaction...');
  const contract = new MinaGuard(PublicKey.fromBase58(bundle.contractAddress));

  const tx = await Mina.transaction(txSender(executor), async () => {
    if (newAccountCount > 0) {
      AccountUpdate.fundNewAccount(executor, newAccountCount);
    }

    if (txType === 'transfer') {
      await contract.executeTransfer(proposalStruct, approvalWitness, approvalCount);
      return;
    }

    if (txType === 'allocateChild') {
      await contract.executeAllocateToChildren(proposalStruct, approvalWitness, approvalCount);
      return;
    }

    if (txType === 'addOwner' || txType === 'removeOwner') {
      const target = proposalStruct.receivers[0].address;
      const pred = ownerStore.sortedPredecessor(target);
      const insertAfter =
        txType === 'addOwner' && pred
          ? new PublicKeyOption({ value: pred, isSome: Bool(true) })
          : PublicKeyOption.none();
      await contract.executeOwnerChange(
        proposalStruct, approvalWitness, approvalCount, ownerStore.getWitness(), insertAfter,
      );
      return;
    }

    if (txType === 'changeThreshold') {
      await contract.executeThresholdChange(
        proposalStruct, approvalWitness, approvalCount, Field(bundle.proposal.data ?? '0'),
      );
      return;
    }

    if (txType === 'setDelegate') {
      await contract.executeDelegate(proposalStruct, approvalWitness, approvalCount);
      return;
    }

    throw new Error(`Unsupported proposal type for execution: ${txType ?? 'unknown'}`);
  });

  log('Generating zero-knowledge proof (this will take a while)...');
  const t0 = performance.now();
  await maybeProve(tx);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  log(`Proof generated in ${elapsed}s`);

  log('Signing fee payer...');
  const signedTxJson = signFeePayer(serializeTx(tx), privateKey, bundle.minaNetwork);

  return {
    version: 1,
    type: 'offline-signed-tx',
    action: 'execute',
    contractAddress: bundle.contractAddress,
    proposalHash: hashStr,
    transaction: JSON.parse(signedTxJson),
  };
}
