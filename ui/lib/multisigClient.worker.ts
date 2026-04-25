// -- Multisig Contract Worker ------------------------------------------
// Runs o1js compilation and proof generation off the main thread.

import * as Comlink from 'comlink';

import {
  Mina,
  Field,
  Scalar,
  UInt64,
  fetchAccount,
  AccountUpdate,
  PublicKey,
  PrivateKey,
  Signature,
  sendZkapp,
  Bool,
  MerkleMap,
  Poseidon,
  Proof,
  Void,
} from 'o1js';

import Client from 'mina-signer';

import {
  MinaGuard,
  Receiver,
  TransactionProposal,
  EXECUTED_MARKER,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
  SetupOwnersInput,
  OwnerStore,
  VoteNullifierStore,
  ApprovalStore,
  PublicKeyOption,
  Destination,
} from 'contracts';

import {
  type NewProposalInput,
  type Proposal,
  normalizeTxType,
  EMPTY_PUBKEY_B58,
} from '@/lib/types';
import {
  fetchAllEvents,
} from './api';

/** Callback type for sending a signed transaction via Auro wallet on the main thread. */
type SendTxFn = (txJson: string) => Promise<string | null>;

/** Callback type for requesting a field signature from Auro or Ledger on the main thread.
 *  Auro returns a base58 signature string; Ledger returns {field, scalar} decimal strings. */
type SignFieldsFn = (
  fields: Array<string>
) => Promise<{ data: Array<string>; signature: string | { field: string; scalar: string } } | null>;

/** Callback type for signing the fee payer commitment via Ledger on the main thread. */
type SignFeePayerFn = (commitment: string) => Promise<{ field: string; scalar: string } | null>;

/** Callback type for reporting step-based progress to the main thread. */
type ProgressFn = (step: string) => void;

const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const ARCHIVE_ENDPOINT = process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT ?? 'https://api.minascan.io/archive/devnet/v1/graphql';

// TODO: make fee configurable per network (e.g. from env or UI input)
const ZKAPP_TX_FEE = 0.1e9; // 0.1 MINA in nanomina

let compilePromise: Promise<void> | null = null;

// -- E2E test mode --------------------------------------------------------
// When a test private key is set, the worker signs and sends transactions
// directly instead of delegating to the Auro wallet on the main thread.
let testPrivateKey: InstanceType<typeof PrivateKey> | null = null;
let skipProofs = false;

class DummyProof extends Proof<void, void> {
  static publicInputType = Void;
  static publicOutputType = Void;
}

let _dummyProofBase64: string | null = null;

async function getDummyProofBase64(): Promise<string> {
  if (_dummyProofBase64) return _dummyProofBase64;
  const p = await DummyProof.dummy(undefined, undefined, 2);
  _dummyProofBase64 = p.toJSON().proof;
  return _dummyProofBase64;
}

async function maybeProve(tx: Awaited<ReturnType<typeof Mina.transaction>>) {
  if (!skipProofs) {
    await tx.prove();
    // o1js registers a FinalizationRegistry (kimchi_bindings/js/bindings/util.js)
    // that calls .free() on WASM objects (prover keys, verifier indices) when
    // their JS wrappers are GC'd, releasing the Rust-side WASM heap memory.
    //
    // When compile() deserializes keys from our IDB cache (via decodeProverKey →
    // wasm.caml_pasta_fp_plonk_index_decode), the resulting WASM wrapper objects
    // have different reference-rooting than freshly-compiled ones. After the
    // first prove(), V8 GC collects an intermediate wrapper and the finalizer
    // frees the underlying pointer — but the prover still holds a reference to
    // that same pointer. The second prove() then hits dangling WASM memory
    // (observed as "unaligned accesses" / WasmFpPlonkVerifierIndexFinalization
    // errors, or a silent hang).
    //
    // Without cache, keys are created through Pickles' Rust compilation path
    // which roots WASM objects differently — no premature finalization.
    //
    // Fix: reset compile state so the next tx recompiles from warm IDB cache
    // (~15s, not minutes), producing fresh WASM objects.
    compileSucceeded = false;
    compilePromise = null;
    return;
  }
  const dummyProof = await getDummyProofBase64();
  for (const au of (tx as any).transaction.accountUpdates) {
    if (au.lazyAuthorization?.kind === 'lazy-proof') {
      au.authorization = { proof: dummyProof };
      au.lazyAuthorization = undefined;
    }
  }
}

/** Returns Mina.transaction sender arg — includes fee since we always set it explicitly. */
function txSender(pub: InstanceType<typeof PublicKey>) {
  return { sender: pub, fee: ZKAPP_TX_FEE };
}

/**
 * Force-clear any stale o1js transaction context left by a previous failed
 * Mina.transaction() call.  o1js's createTransaction has code paths where a
 * thrown error skips currentTransaction.leave(), leaving the global context
 * dirty so that every subsequent Mina.transaction() call throws
 * "Cannot start new transaction within another transaction".
 *
 * Safe to call unconditionally: this worker is single-threaded, so if
 * currentTransaction.has() is true right before we start a new transaction,
 * it is always stale.
 */
function clearStaleTransaction() {
  const ctx = Mina.currentTransaction;
  while (ctx.has()) {
    console.warn('[MultisigWorker] Clearing stale o1js transaction context');
    ctx.leave(ctx.id());
  }
}

/** Contract state snapshot read directly from chain. */
interface ContractState {
  ownersCommitment: string;
  threshold: number;
  numOwners: number;
  nonce: number;
  voteNullifierRoot: string;
  approvalRoot: string;
  configNonce: number;
  networkId: string;
}

function configureNetwork() {
  const network = Mina.Network({
    networkId: (process.env.NEXT_PUBLIC_MINA_NETWORK as 'mainnet' | 'testnet' | 'devnet') || 'testnet',
    mina: MINA_ENDPOINT,
    archive: ARCHIVE_ENDPOINT,
  });
  if (skipProofs) network.proofsEnabled = false;
  Mina.setActiveInstance(network);
}

let compileSucceeded = false;
let idbCache: Awaited<ReturnType<typeof import('./idb-compile-cache').createIndexedDBCache>> | null = null;

async function compileContract(): Promise<boolean> {
  if (compileSucceeded) return true;

  if (!compilePromise) {
    compilePromise = (async () => {
      console.log('[MultisigWorker] MinaGuard.compile() starting');
      const t0 = performance.now();
      configureNetwork();
      if (!idbCache) {
        const { createIndexedDBCache } = await import('./idb-compile-cache');
        idbCache = await createIndexedDBCache();
      }
      await MinaGuard.compile({ cache: idbCache });
      const { getCompileCacheSize } = await import('./idb-compile-cache');
      const size = await getCompileCacheSize();
      console.log(`[MultisigWorker] MinaGuard.compile() done in ${((performance.now() - t0) / 1000).toFixed(1)}s — cache: ${(size.bytes / 1024 / 1024).toFixed(0)}MB (${size.entries} entries)`);
    })();
  }

  try {
    await compilePromise;
    compileSucceeded = true;
    return true;
  } catch (error) {
    console.error('[MultisigWorker] Contract compile failed', error);
    compilePromise = null;
    return false;
  }
}

async function fetchContractState(
  contractAddress: string
): Promise<ContractState | null> {
  try {
    configureNetwork();
    const address = PublicKey.fromBase58(contractAddress);
    await fetchAccount({ publicKey: address });
    const zkApp = new MinaGuard(address);
    return {
      ownersCommitment: zkApp.ownersCommitment.get().toString(),
      threshold: Number(zkApp.threshold.get().toString()),
      numOwners: Number(zkApp.numOwners.get().toString()),
      nonce: Number(zkApp.nonce.get().toString()),
      voteNullifierRoot: zkApp.voteNullifierRoot.get().toString(),
      approvalRoot: zkApp.approvalRoot.get().toString(),
      configNonce: Number(zkApp.configNonce.get().toString()),
      networkId: zkApp.networkId.get().toString(),
    };
  } catch (error) {
    console.error('[MultisigWorker] Failed to fetch contract state', error);
    return null;
  }
}

async function signProposalHash(
  hashAsFieldString: string,
  signFn: SignFieldsFn
): Promise<ReturnType<typeof Signature.fromBase58> | null> {
  if (testPrivateKey) {
    return Signature.create(testPrivateKey, [Field(hashAsFieldString)]);
  }
  const signed = await signFn([hashAsFieldString]);
  if (!signed?.signature) return null;
  try {
    if (typeof signed.signature === 'string') {
      return Signature.fromBase58(signed.signature);
    }
    // Ledger returns {field, scalar} decimal strings
    return Signature.fromObject({
      r: Field(BigInt(signed.signature.field)),
      s: Scalar.from(BigInt(signed.signature.scalar)),
    });
  } catch {
    return null;
  }
}

/** Signs the fee payer, sends directly to the network, and returns the formatted success message. */
async function signAndSend(
  tx: Awaited<ReturnType<typeof Mina.transaction>>,
  extraKeys: InstanceType<typeof PrivateKey>[] = []
): Promise<string> {
  tx.sign([testPrivateKey!, ...extraKeys]);
  const result = await tx.send();
  const hash = typeof result.hash === 'function'
    ? (result.hash as () => string)()
    : result.hash;

  const errors = (result as any).errors as Array<{ message?: string }> | undefined;
  if (errors?.length) {
    const message = errors.map((e) => e?.message ?? 'Unknown error').join('; ');
    throw new Error(`Transaction rejected by node: ${message}`);
  }
  if ((result as any).status === 'rejected') {
    throw new Error('Transaction was rejected by the node');
  }

  console.log('[MultisigWorker] Transaction sent:', hash);
  return `Transaction submitted: ${hash}`;
}

async function rebuildStoresFromBackend(contractAddress: string) {
  const ownerStore = new OwnerStore();
  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();
  const events = await fetchAllEvents(contractAddress);

  // Owners are kept in ascending base58 order so the commitment is
  // deterministic regardless of archive event ordering.
  const emptyKey = PublicKey.empty().toBase58();
  const setupOwnerEntries = events
    .filter(e => e.eventType === 'setupOwner')
    .map(e => {
      const p = e.payload as Record<string, unknown>;
      return { owner: p.owner };
    })
    .filter(({ owner }) => typeof owner === 'string' && (owner as string).length > 10 && owner !== emptyKey)
    .sort((a, b) => (a.owner as string) > (b.owner as string) ? 1 : -1);
  for (const { owner } of setupOwnerEntries) {
    ownerStore.addSorted(PublicKey.fromBase58(owner as string));
  }

  for (const event of events) {
    if (event.eventType === 'setupOwner') {
      continue; // handled above with explicit index ordering
    }

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
        approvalStore.setCount(Field(proposalHash), PROPOSED_MARKER.add(1));
      }
      // The contract's propose() also nullifies the proposer's vote
      if (
        typeof proposalHash === 'string' &&
        typeof proposer === 'string' &&
        proposer.length > 10
      ) {
        nullifierStore.nullify(
          Field(proposalHash),
          PublicKey.fromBase58(proposer)
        );
      }
      continue;
    }

    if (event.eventType === 'approval') {
      const payload = event.payload as Record<string, unknown>;
      const proposalHash = payload.proposalHash;
      const approver = payload.approver;
      const approvalCount = payload.approvalCount;

      if (
        typeof proposalHash === 'string' &&
        typeof approvalCount === 'string'
      ) {
        approvalStore.setCount(Field(proposalHash), Field(approvalCount));
      }

      if (
        typeof proposalHash === 'string' &&
        typeof approver === 'string' &&
        approver.length > 10
      ) {
        nullifierStore.nullify(
          Field(proposalHash),
          PublicKey.fromBase58(approver)
        );
      }
      continue;
    }

    if (event.eventType === 'execution' || event.eventType === 'executionBatch') {
      const payload = event.payload as Record<string, unknown>;
      const proposalHash = payload.proposalHash;
      const txType = payload.txType;
      // REMOTE child-lifecycle methods (CREATE_CHILD=5, RECLAIM_CHILD=7,
      // DESTROY_CHILD=8, ENABLE_CHILD_MULTI_SIG=9) emit `execution` events on
      // the child, but they touch `childExecutionRoot` — NOT `approvalRoot`.
      // Skip those here so the reconstructed approvalStore stays in sync with
      // the on-chain approvalRoot (rebuildChildExecutionMap handles the other
      // map separately).
      const isRemoteExecution =
        typeof txType === 'string' && (txType === '5' || txType === '7' || txType === '8' || txType === '9');
      if (typeof proposalHash === 'string' && !isRemoteExecution) {
        approvalStore.setCount(Field(proposalHash), EXECUTED_MARKER);
      }
    }
  }

  return { ownerStore, approvalStore, nullifierStore };
}

/**
 * Dumps on-chain vs locally-rebuilt values side-by-side so a failed
 * propose() tx.prove() can be narrowed to the specific mismatched constraint
 * (owner commitment, nullifier/approval root, configNonce, networkId, nonce).
 */
function logProposeDiagnostics(args: {
  contract: InstanceType<typeof MinaGuard>;
  contractAddress: InstanceType<typeof PublicKey>;
  proposer: InstanceType<typeof PublicKey>;
  proposal: InstanceType<typeof TransactionProposal>;
  proposalHash: InstanceType<typeof Field>;
  signature: InstanceType<typeof Signature>;
  ownerStore: InstanceType<typeof OwnerStore>;
  approvalStore: InstanceType<typeof ApprovalStore>;
  nullifierStore: InstanceType<typeof VoteNullifierStore>;
}) {
  const {
    contract, contractAddress, proposer, proposal, proposalHash, signature,
    ownerStore, approvalStore, nullifierStore,
  } = args;
  const dump = {
    contractAddress: contractAddress.toBase58(),
    proposer: proposer.toBase58(),
    proposalHash: proposalHash.toString(),
    signatureVerifies: signature.verify(proposer, [proposalHash]).toBoolean(),
    proposalGuardAddress: proposal.guardAddress.toBase58(),
    proposalChildAccount: proposal.childAccount.toBase58(),
    proposalDestination: proposal.destination.toString(),
    proposalTxType: proposal.txType.toString(),
    proposalData: proposal.data.toString(),
    proposalExpiryBlock: proposal.expiryBlock.toString(),
    proposalReceiver0: proposal.receivers[0].address.toBase58(),
    onchainOwnersCommitment: contract.ownersCommitment.get().toString(),
    storeOwnersCommitment: ownerStore.getCommitment().toString(),
    onchainNonce: contract.nonce.get().toString(),
    proposalNonce: proposal.nonce.toString(),
    onchainConfigNonce: contract.configNonce.get().toString(),
    proposalConfigNonce: proposal.configNonce.toString(),
    onchainNetworkId: contract.networkId.get().toString(),
    proposalNetworkId: proposal.networkId.toString(),
    onchainVoteNullifierRoot: contract.voteNullifierRoot.get().toString(),
    storeVoteNullifierRoot: nullifierStore.getRoot().toString(),
    onchainApprovalRoot: contract.approvalRoot.get().toString(),
    storeApprovalRoot: approvalStore.getRoot().toString(),
    onchainParent: contract.parent.get().toBase58(),
    onchainChildMultiSigEnabled: contract.childMultiSigEnabled.get().toString(),
    proposerIsOwner: ownerStore.isOwner(proposer),
    ownerCount: ownerStore.length,
  };
  // Logged as a JSON string so each field stays inline-copyable even when
  // devtools can't clone/serialize the object form (observed with Chrome
  // freezing on worker-side o1js objects).
  console.log('[propose debug]\n' + JSON.stringify(dump, null, 2));
}

/**
 * Rebuilds the child's `childExecutionRoot` MerkleMap from indexed events.
 *
 * The child writes EXECUTED_MARKER at proposalHash on each lifecycle method
 * (executeReclaim / executeDestroy / executeEnableChildMultiSig). Reconstruct
 * by scanning the child's `execution` events and inserting EXECUTED_MARKER
 * for every REMOTE-execution proposalHash.
 */
async function rebuildChildExecutionMap(childAddress: string): Promise<InstanceType<typeof MerkleMap>> {
  const map = new MerkleMap();
  const events = await fetchAllEvents(childAddress);

  // The numeric TxType field values for REMOTE child-lifecycle methods.
  const remoteExecutionTypes = new Set(['7', '8', '9']); // RECLAIM, DESTROY, ENABLE_CHILD_MULTI_SIG

  for (const event of events) {
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

/** Safely parses a base58 public key, falling back to PublicKey.empty() for the zero point. */
function safePublicKey(base58: string | null | undefined): InstanceType<typeof PublicKey> {
  if (!base58) return PublicKey.empty();
  try {
    return PublicKey.fromBase58(base58);
  } catch {
    return PublicKey.empty();
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

function buildProposalDataField(input: NewProposalInput): InstanceType<typeof Field> {
  if (input.txType === 'changeThreshold') {
    return Field(input.newThreshold ?? 0);
  }
  if (input.txType === 'reclaimChild') {
    return Field(input.reclaimAmount ?? '0');
  }
  if (input.txType === 'enableChildMultiSig') {
    return Field(input.childMultiSigEnable ? 1 : 0);
  }
  if (input.txType === 'createChild') {
    return Field(input.createChildConfigHash ?? '0');
  }
  return Field(0);
}

/** Governance target address for the proposal, or null for transfer / threshold / undelegate. */
function governanceTargetAddress(input: NewProposalInput): string | null {
  if (input.txType === 'addOwner') return input.newOwner ?? null;
  if (input.txType === 'removeOwner') return input.removeOwnerAddress ?? null;
  if (input.txType === 'setDelegate' && !input.undelegate) return input.delegate ?? null;
  return null;
}

/** Builds the receivers array for a new proposal per on-chain encoding:
 *  - transfer: user-entered receivers, padded with empties.
 *  - governance (addOwner/removeOwner/setDelegate set): target pubkey in slot 0 with amount=0.
 *  - threshold / undelegate: all empty slots.
 */
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

function buildTransferReceivers(
  receivers: Array<{ address: string; amount: string }>
): InstanceType<typeof Receiver>[] {
  const normalized = receivers.map((receiver) => new Receiver({
    // PublicKey.empty() produces a sentinel at (x=0, isOdd=false) — a point
    // that ISN'T on the curve, so PublicKey.fromBase58 rejects its own
    // toBase58() output with "not a valid group element". Use the sentinel
    // directly for the delete-flow empty receiver.
    address: receiver.address === EMPTY_PUBKEY_B58
      ? PublicKey.empty()
      : PublicKey.fromBase58(receiver.address),
    amount: UInt64.from(receiver.amount),
  }));

  while (normalized.length < MAX_RECEIVERS) {
    normalized.push(Receiver.empty());
  }

  return normalized.slice(0, MAX_RECEIVERS);
}

function buildProposalStruct(
  proposal: Pick<
    Proposal,
    'receivers' | 'tokenId' | 'txType' | 'data' | 'nonce' | 'configNonce' | 'expiryBlock' | 'networkId' | 'guardAddress' | 'destination' | 'childAccount'
  >,
  fallbackGuardAddress: string
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
    expiryBlock: Field(proposal.expiryBlock ?? '0'),
    networkId: Field(proposal.networkId ?? '0'),
    guardAddress: safePublicKey(proposal.guardAddress ?? fallbackGuardAddress),
    destination,
    childAccount,
  });
}

/** Safely serializes tx.toJSON() regardless of whether it returns a string or object. */
function serializeTx(tx: Awaited<ReturnType<typeof Mina.transaction>>): string {
  const json = tx.toJSON();
  return typeof json === 'string' ? json : JSON.stringify(json);
}

/** mina-signer client for computing transaction commitments without o1js overhead. */
const signerClient = new Client({
  network: (process.env.NEXT_PUBLIC_MINA_NETWORK as 'mainnet' | 'testnet' | 'devnet') || 'testnet',
});

/** Signs the fee payer via Ledger and broadcasts directly to the Mina GraphQL endpoint. */
async function broadcastWithLedgerSig(
  txJson: string,
  signFeePayerFn: SignFeePayerFn
): Promise<string | null> {
  const parsed = JSON.parse(txJson);
  // mina-signer expects { feePayer, zkappCommand } wrapper; parsed is the raw tx JSON
  const wrapped = { feePayer: parsed.feePayer, zkappCommand: parsed };
  const { fullCommitment } = signerClient.getZkappCommandCommitmentsNoCheck(wrapped);
  const sig = await signFeePayerFn(fullCommitment.toString());
  if (!sig) return null;

  const sigBase58 = Signature.fromObject({
    r: Field(BigInt(sig.field)),
    s: Scalar.from(BigInt(sig.scalar)),
  }).toBase58();

  parsed.feePayer.authorization = sigBase58;

  // Also sign any account updates owned by the fee payer that require a signature
  // (e.g. fundNewAccount). These use fullCommitment when useFullCommitment is true.
  const feePayerPk = parsed.feePayer.body.publicKey;
  for (const update of parsed.accountUpdates ?? []) {
    if (
      update.body?.publicKey === feePayerPk &&
      update.body?.authorizationKind?.isSigned === true &&
      update.body?.useFullCommitment === true
    ) {
      update.authorization = { signature: sigBase58 };
    }
  }

  const [response, error] = await sendZkapp(JSON.stringify(parsed));
  if (error) {
    const message = typeof error === 'string'
      ? error
      : (error as { message?: string })?.message ?? JSON.stringify(error);
    throw new Error(`Transaction rejected by node: ${message}`);
  }
  const hash = response?.data?.sendZkapp?.zkapp?.hash;
  if (!hash) throw new Error('sendZkapp returned no tx hash');
  return hash;
}

/** Dispatches transaction submission to test mode, Ledger, or Auro. */
async function submitTx(
  tx: Awaited<ReturnType<typeof Mina.transaction>>,
  sendFn: SendTxFn | null,
  signFeePayerFn?: SignFeePayerFn,
  extraKeys: InstanceType<typeof PrivateKey>[] = []
): Promise<string | null> {
  // E2E test mode: sign and send directly
  if (testPrivateKey) {
    return await signAndSend(tx, extraKeys);
  }
  // Sign with extra keys (e.g. zkApp key for deploy) before Auro/Ledger submission
  if (extraKeys.length > 0) {
    tx.sign(extraKeys);
  }
  const txJson = serializeTx(tx);
  // Ledger path: sign fee payer via Ledger and broadcast directly
  if (signFeePayerFn) {
    return broadcastWithLedgerSig(txJson, signFeePayerFn);
  }
  // Auro path: send via Auro wallet
  if (sendFn) {
    return sendFn(txJson);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public worker API exposed via Comlink
// ---------------------------------------------------------------------------

const workerApi = {
  /** Sets the private key for e2e test mode (direct sign/send, no Auro). */
  setTestKey(privateKeyBase58: string) {
    if (process.env.NEXT_PUBLIC_E2E_TEST !== 'true') {
      console.warn('[MultisigWorker] setTestKey called outside E2E mode, ignoring');
      return;
    }
    testPrivateKey = PrivateKey.fromBase58(privateKeyBase58);
  },

  /** Disables proof generation (for use with lightnet / test environments). */
  setSkipProofs(skip: boolean) {
    if (process.env.NEXT_PUBLIC_E2E_TEST !== 'true') {
      console.warn('[MultisigWorker] setSkipProofs called outside E2E mode, ignoring');
      return;
    }
    skipProofs = skip;
  },

  async deployContract(
    params: { feePayerAddress: string; zkAppPrivateKeyBase58: string },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Building transaction...');
    const feePayer = PublicKey.fromBase58(params.feePayerAddress);
    const zkAppKey = PrivateKey.fromBase58(params.zkAppPrivateKeyBase58);
    const zkAppAddress = zkAppKey.toPublicKey();
    const zkApp = new MinaGuard(zkAppAddress);

    await fetchAccount({ publicKey: feePayer });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(feePayer), async () => {
      AccountUpdate.fundNewAccount(feePayer);
      await zkApp.deploy();
    });

    console.log('mina transaction constructed');

    progressFn('Generating proof...');
    await maybeProve(tx);

    console.log('proof done');

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const deployHash = await submitTx(tx, sendFn, signFeePayerFn, [zkAppKey]);
    console.log('[MultisigWorker] deploy tx result:', deployHash);
    return `Transaction submitted: ${deployHash}`;
  },

  async deployAndSetupContract(
    params: {
      feePayerAddress: string;
      zkAppPrivateKeyBase58: string;
      owners: string[];
      threshold: number;
      networkId: string;
    },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    console.log('[MultisigWorker] deployAndSetupContract entered');
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    configureNetwork();
    progressFn('Building transaction...');
    const feePayer = PublicKey.fromBase58(params.feePayerAddress);
    const zkAppKey = PrivateKey.fromBase58(params.zkAppPrivateKeyBase58);
    const zkAppAddress = zkAppKey.toPublicKey();
    const zkApp = new MinaGuard(zkAppAddress);

    const ownerStore = new OwnerStore();
    const ownerKeys = params.owners.map((address) => PublicKey.fromBase58(address));
    for (const owner of ownerKeys) ownerStore.addSorted(owner);

    const paddedOwners = [...ownerStore.owners];
    while (paddedOwners.length < MAX_OWNERS) {
      paddedOwners.push(PublicKey.empty());
    }

    await fetchAccount({ publicKey: feePayer });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(feePayer), async () => {
      AccountUpdate.fundNewAccount(feePayer);
      await zkApp.deploy();
      await zkApp.setup(
        ownerStore.getCommitment(),
        Field(params.threshold),
        Field(ownerKeys.length),
        Field(params.networkId),
        new SetupOwnersInput({ owners: paddedOwners.slice(0, MAX_OWNERS) })
      );
    });

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn, [zkAppKey]);
    return `Transaction submitted: ${txHash}`;
  },

  async setupContract(
    params: {
      zkAppAddress: string;
      feePayerAddress: string;
      owners: string[];
      threshold: number;
      networkId: string;
    },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Building transaction...');
    const ownerStore = new OwnerStore();
    const ownerKeys = params.owners.map((address) => PublicKey.fromBase58(address));
    for (const owner of ownerKeys) ownerStore.addSorted(owner);

    const paddedOwners = [...ownerStore.owners];
    while (paddedOwners.length < MAX_OWNERS) {
      paddedOwners.push(PublicKey.empty());
    }

    const zkAppAddress = PublicKey.fromBase58(params.zkAppAddress);
    const feePayer = PublicKey.fromBase58(params.feePayerAddress);
    const zkApp = new MinaGuard(zkAppAddress);

    await fetchAccount({ publicKey: feePayer });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(feePayer), async () => {
      await zkApp.setup(
        ownerStore.getCommitment(),
        Field(params.threshold),
        Field(ownerStore.length),
        Field(params.networkId),
        new SetupOwnersInput({
          owners: paddedOwners.slice(0, MAX_OWNERS),
        })
      );
    });

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn);
    console.log('[MultisigWorker] setup tx result:', txHash);
    return `Transaction submitted: ${txHash}`;
  },

  /**
   * Creates an on-chain proposal via zkApp.propose(). Auto-approves the proposer.
   * Returns the proposalHash on success so the UI can route to the detail page.
   */
  async createOnchainProposal(
    params: {
      contractAddress: string;
      proposerAddress: string;
      input: NewProposalInput;
      configNonce: number;
      networkId: string;
    },
    signFn: SignFieldsFn,
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    configureNetwork();
    const ok = await compileContract();
    if (!ok) return null;

    const receivers = buildReceiversForProposal(params.input);
    const txType = uiTxTypeToField(params.input.txType);
    const data = buildProposalDataField(params.input);

    const isRemote =
      params.input.txType === 'createChild' ||
      params.input.txType === 'reclaimChild' ||
      params.input.txType === 'destroyChild' ||
      params.input.txType === 'enableChildMultiSig';

    const proposal = new TransactionProposal({
      receivers,
      tokenId: Field(0),
      txType,
      data,
      nonce: Field(params.input.nonce),
      configNonce: Field(params.configNonce),
      expiryBlock: Field(params.input.expiryBlock ?? 0),
      networkId: Field(params.networkId),
      guardAddress: PublicKey.fromBase58(params.contractAddress),
      destination: isRemote ? Destination.REMOTE : Destination.LOCAL,
      childAccount: params.input.childAccount
        ? PublicKey.fromBase58(params.input.childAccount)
        : PublicKey.empty(),
    });

    const proposalHash = proposal.hash();
    const hashStr = proposalHash.toString();

    progressFn(testPrivateKey ? 'Signing proposal hash...' : 'Awaiting wallet signature...');
    const signature = await signProposalHash(hashStr, signFn);
    if (!signature) return null;

    progressFn('Rebuilding stores...');
    const { ownerStore, approvalStore, nullifierStore } = await rebuildStoresFromBackend(params.contractAddress);

    const proposer = PublicKey.fromBase58(params.proposerAddress);
    const ownerWitness = ownerStore.getWitness();
    const nullifierWitness = nullifierStore.getWitness(proposalHash, proposer);
    const approvalWitness = approvalStore.getWitness(proposalHash);

    progressFn('Building transaction...');
    const contractAddress = PublicKey.fromBase58(params.contractAddress);
    const contract = new MinaGuard(contractAddress);
    // The circuit reads ownersCommitment / voteNullifierRoot / approvalRoot /
    // configNonce / networkId / nonce via getAndRequireEquals(); without a
    // fresh fetch of the zkApp account, o1js sees Field(0) and the circuit
    // traps with a WASM `unreachable` during prove.
    const fetches: Promise<any>[] = [
      fetchAccount({ publicKey: proposer }),
      fetchAccount({ publicKey: contractAddress }),
    ];
    // REMOTE proposals read child state (parentNonce, ownersCommitment, parent)
    // via getAndRequireEquals() inside propose(). Without a prefetch, o1js
    // auto-fetches inside Mina.transaction() which hangs in the worker.
    const childAccount = proposal.childAccount;
    if (!childAccount.equals(PublicKey.empty()).toBoolean()) {
      fetches.push(fetchAccount({ publicKey: childAccount }));
    }
    await Promise.all(fetches);

    logProposeDiagnostics({
      contract,
      contractAddress,
      proposer,
      proposal,
      proposalHash,
      signature,
      ownerStore,
      approvalStore,
      nullifierStore,
    });

    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(proposer), async () => {
      await contract.propose(
        proposal,
        ownerWitness,
        proposer,
        signature,
        nullifierWitness,
        approvalWitness
      );
    });

    // Rayon's thread pool inside o1js requires SharedArrayBuffer, which is
    // only available when the worker scope is cross-origin isolated. If
    // isolation is broken (e.g. missing CORP header on _next/static/*),
    // prove() traps with WASM `unreachable` during pool startup. Logging
    // this makes header regressions obvious.
    console.log('[prove env] ' + JSON.stringify({
      crossOriginIsolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      hardwareConcurrency: self.navigator?.hardwareConcurrency ?? null,
    }));

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn);
    if (!txHash) return null;
    return hashStr;
  },

  /**
   * Submits an on-chain approveProposal tx for the given proposal. Each approver
   * sends their own transaction and signs the proposal hash with their wallet.
   */
  async approveProposalOnchain(
    params: {
      contractAddress: string;
      approverAddress: string;
      proposal: Proposal;
    },
    signFn: SignFieldsFn,
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    configureNetwork();
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Fetching on-chain state...');
    const contractState = await fetchContractState(params.contractAddress);
    if (!contractState) return null;

    progressFn('Rebuilding stores...');
    const { ownerStore, approvalStore, nullifierStore } = await rebuildStoresFromBackend(params.contractAddress);

    const proposalStruct = buildProposalStruct({
      ...params.proposal,
      configNonce: params.proposal.configNonce ?? String(contractState.configNonce),
      networkId: params.proposal.networkId ?? contractState.networkId,
      guardAddress: params.proposal.guardAddress ?? params.contractAddress,
    }, params.contractAddress);

    const proposalHash = proposalStruct.hash();
    const hashStr = proposalHash.toString();

    progressFn(testPrivateKey ? 'Signing proposal hash...' : 'Awaiting wallet signature...');
    const signature = await signProposalHash(hashStr, signFn);
    if (!signature) return null;

    const approver = PublicKey.fromBase58(params.approverAddress);
    const ownerWitness = ownerStore.getWitness();
    const approvalWitness = approvalStore.getWitness(proposalHash);
    const nullifierWitness = nullifierStore.getWitness(proposalHash, approver);
    const currentApprovalCount = approvalStore.getCount(proposalHash);

    progressFn('Building transaction...');
    const contract = new MinaGuard(PublicKey.fromBase58(params.contractAddress));
    await fetchAccount({ publicKey: approver });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(approver), async () => {
      await contract.approveProposal(
        proposalStruct,
        signature,
        approver,
        ownerWitness,
        approvalWitness,
        currentApprovalCount,
        nullifierWitness
      );
    });

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn);
    if (!txHash) return null;
    return `Approval submitted: ${txHash}`;
  },

  /**
   * Submits the appropriate single-sig execute* transaction for the proposal's
   * txType. Assumes on-chain approval count already meets the threshold.
   */
  async executeProposalOnchain(
    params: {
      contractAddress: string;
      executorAddress: string;
      proposal: Proposal;
    },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    configureNetwork();
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Fetching on-chain state...');
    const contractState = await fetchContractState(params.contractAddress);
    if (!contractState) return null;

    progressFn('Rebuilding stores...');
    const { ownerStore, approvalStore } = await rebuildStoresFromBackend(params.contractAddress);

    const txType = normalizeTxType(params.proposal.txType);
    const proposalStruct = buildProposalStruct({
      ...params.proposal,
      configNonce: params.proposal.configNonce ?? String(contractState.configNonce),
      networkId: params.proposal.networkId ?? contractState.networkId,
      guardAddress: params.proposal.guardAddress ?? params.contractAddress,
    }, params.contractAddress);

    const proposalHash = proposalStruct.hash();
    const approvalWitness = approvalStore.getWitness(proposalHash);
    const approvalCount = approvalStore.getCount(proposalHash);

    progressFn('Building transaction...');
    const contract = new MinaGuard(PublicKey.fromBase58(params.contractAddress));
    const executor = PublicKey.fromBase58(params.executorAddress);

    await fetchAccount({ publicKey: executor });

    // For fund-moving executes, every recipient that doesn't yet exist on
    // chain costs 1 MINA of account-creation fee. Without an explicit
    // AccountUpdate.fundNewAccount(executor, N) inside the tx, the node
    // rejects with Invalid_fee_excess.
    let newAccountCount = 0;
    if (txType === 'transfer' || txType === 'allocateChild') {
      for (const r of params.proposal.receivers ?? []) {
        if (!r.address || r.address === EMPTY_PUBKEY_B58) continue;
        const { account } = await fetchAccount({ publicKey: PublicKey.fromBase58(r.address) });
        if (!account) newAccountCount += 1;
      }
    }

    clearStaleTransaction();
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
          proposalStruct, approvalWitness, approvalCount, ownerStore.getWitness(), insertAfter
        );
        return;
      }

      if (txType === 'changeThreshold') {
        await contract.executeThresholdChange(
          proposalStruct, approvalWitness, approvalCount, Field(params.proposal.data ?? '0')
        );
        return;
      }

      if (txType === 'setDelegate') {
        await contract.executeDelegate(proposalStruct, approvalWitness, approvalCount);
        return;
      }

      throw new Error('Unsupported proposal type for execution');
    });

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const executeHash = await submitTx(tx, sendFn, signFeePayerFn);
    if (!executeHash) return null;
    return `Transaction submitted: ${executeHash}`;
  },

  /**
   * Deploys a fresh MinaGuard at `childPrivateKey` and runs `executeSetupChild`
   * in the same transaction. Used to finalize a CREATE_CHILD parent proposal
   * once it has reached threshold.
   *
   * Single-tx so a deployed-but-unconfigured child can't be hijacked by an
   * attacker calling `executeSetupChild` with a different proposal.
   */
  async deployAndSetupChildOnchain(
    params: {
      parentAddress: string;
      childPrivateKeyBase58: string;
      feePayerAddress: string;
      childOwners: string[];
      childThreshold: number;
      proposal: Proposal; // the parent's CREATE_CHILD proposal
    },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    configureNetwork();
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Rebuilding parent stores...');
    const { approvalStore } = await rebuildStoresFromBackend(params.parentAddress);

    const childKey = PrivateKey.fromBase58(params.childPrivateKeyBase58);
    const childAddress = childKey.toPublicKey();
    const feePayer = PublicKey.fromBase58(params.feePayerAddress);

    const ownerStore = new OwnerStore();
    const ownerKeys = params.childOwners.map((address) => PublicKey.fromBase58(address));
    for (const owner of ownerKeys) ownerStore.addSorted(owner);
    const paddedOwners = [...ownerStore.owners];
    while (paddedOwners.length < MAX_OWNERS) paddedOwners.push(PublicKey.empty());

    const ownersCommitment = ownerStore.getCommitment();
    const numOwners = Field(ownerKeys.length);
    const threshold = Field(params.childThreshold);

    // Build the REMOTE proposal struct exactly as it was hashed on the parent.
    const proposalStruct = buildProposalStruct({
      ...params.proposal,
      childAccount: params.proposal.childAccount ?? childAddress.toBase58(),
      destination: 'remote',
    }, params.parentAddress);
    const proposalHash = proposalStruct.hash();
    const approvalWitness = approvalStore.getWitness(proposalHash);
    const approvalCount = approvalStore.getCount(proposalHash);

    const childZkApp = new MinaGuard(childAddress);

    progressFn('Building transaction...');
    await fetchAccount({ publicKey: feePayer });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(feePayer), async () => {
      AccountUpdate.fundNewAccount(feePayer);
      await childZkApp.deploy();
      await childZkApp.executeSetupChild(
        ownersCommitment,
        threshold,
        numOwners,
        new SetupOwnersInput({ owners: paddedOwners.slice(0, MAX_OWNERS) }),
        proposalStruct,
        approvalWitness,
        approvalCount,
      );
    });

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn, [childKey]);
    if (!txHash) return null;
    return `Subaccount deployed: ${txHash}`;
  },

  /**
   * Executes a REMOTE child-lifecycle proposal on the child guard:
   * RECLAIM_CHILD / DESTROY_CHILD / ENABLE_CHILD_MULTI_SIG.
   *
   * The child verifies the parent's approval witness via cross-contract
   * preconditions, then mutates its own state and marks the proposal
   * executed in its local `childExecutionRoot`.
   */
  async executeChildLifecycleOnchain(
    params: {
      childAddress: string;
      parentAddress: string;
      executorAddress: string;
      proposal: Proposal;
    },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    configureNetwork();
    const ok = await compileContract();
    if (!ok) return null;

    const txType = normalizeTxType(params.proposal.txType);
    if (
      txType !== 'reclaimChild' &&
      txType !== 'destroyChild' &&
      txType !== 'enableChildMultiSig'
    ) {
      throw new Error(`Unsupported child lifecycle txType: ${txType ?? 'unknown'}`);
    }

    progressFn('Rebuilding parent approval store...');
    const { approvalStore } = await rebuildStoresFromBackend(params.parentAddress);

    progressFn('Rebuilding child execution map...');
    const childExecutionMap = await rebuildChildExecutionMap(params.childAddress);

    const proposalStruct = buildProposalStruct({
      ...params.proposal,
      destination: 'remote',
      childAccount: params.proposal.childAccount ?? params.childAddress,
    }, params.parentAddress);
    const proposalHash = proposalStruct.hash();
    const approvalWitness = approvalStore.getWitness(proposalHash);
    const approvalCount = approvalStore.getCount(proposalHash);
    const childExecutionWitness = childExecutionMap.getWitness(proposalHash);

    const childZkApp = new MinaGuard(PublicKey.fromBase58(params.childAddress));
    const executor = PublicKey.fromBase58(params.executorAddress);

    progressFn('Building transaction...');
    await fetchAccount({ publicKey: executor });
    await fetchAccount({ publicKey: PublicKey.fromBase58(params.childAddress) });
    await fetchAccount({ publicKey: PublicKey.fromBase58(params.parentAddress) });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(executor), async () => {
      if (txType === 'reclaimChild') {
        const amount = UInt64.from(params.proposal.data ?? '0');
        await childZkApp.executeReclaimToParent(
          proposalStruct,
          approvalWitness,
          approvalCount,
          childExecutionWitness,
          amount,
        );
        return;
      }
      if (txType === 'destroyChild') {
        await childZkApp.executeDestroy(
          proposalStruct,
          approvalWitness,
          approvalCount,
          childExecutionWitness,
        );
        return;
      }
      // enableChildMultiSig
      const enabled = Field(params.proposal.data ?? '0');
      await childZkApp.executeEnableChildMultiSig(
        proposalStruct,
        approvalWitness,
        approvalCount,
        childExecutionWitness,
        enabled,
      );
    });

    progressFn('Generating proof...');
    await maybeProve(tx);

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn);
    if (!txHash) return null;
    return `Subaccount action submitted: ${txHash}`;
  },

  /**
   * Computes the createChild `data` field: Poseidon.hash([ownersCommitment, threshold, numOwners]).
   * Exposed so the wizard can compute it without dragging Poseidon into the main thread.
   */
  computeCreateChildConfigHash(params: {
    childOwners: string[];
    childThreshold: number;
  }): { ownersCommitment: string; configHash: string; childAddressKeypair: { privateKey: string; publicKey: string } } {
    const ownerStore = new OwnerStore();
    for (const addr of params.childOwners) {
      ownerStore.addSorted(PublicKey.fromBase58(addr));
    }
    const ownersCommitment = ownerStore.getCommitment();
    const numOwners = Field(params.childOwners.length);
    const threshold = Field(params.childThreshold);
    const configHash = Poseidon.hash([ownersCommitment, threshold, numOwners]);
    const childKey = PrivateKey.random();
    return {
      ownersCommitment: ownersCommitment.toString(),
      configHash: configHash.toString(),
      childAddressKeypair: {
        privateKey: childKey.toBase58(),
        publicKey: childKey.toPublicKey().toBase58(),
      },
    };
  },
};

export type WorkerApi = typeof workerApi;

console.log('[MultisigWorker] worker module loaded, exposing API');
Comlink.expose(workerApi);

// Eagerly start compilation as soon as the worker loads
compileContract().catch(() => { });
