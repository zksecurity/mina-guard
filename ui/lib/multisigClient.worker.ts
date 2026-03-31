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
  Bool
} from 'o1js';

import Client from 'mina-signer';

import {
  MinaGuard,
  Receiver,
  TransactionProposal,
  ownerKey,
  EXECUTED_MARKER,
  PROPOSED_MARKER,
  MAX_OWNERS,
  MAX_RECEIVERS,
  SetupOwnersInput,
  OwnerStore,
  VoteNullifierStore,
  ApprovalStore,
  PublicKeyOption,
  SignatureInputs,
  SignatureInput,
  SignatureOption,
} from 'contracts';

import {
  type NewProposalInput,
  type Proposal,
  normalizeTxType,
} from '@/lib/types';
import {
  fetchAllEvents,
  postOffchainProposal,
  postSignature,
  fetchBatchPayload,
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
  proposalCounter: number;
  voteNullifierRoot: string;
  approvalRoot: string;
  configNonce: number;
  networkId: string;
}

function configureNetwork() {
  const network = Mina.Network({
    mina: MINA_ENDPOINT,
    archive: ARCHIVE_ENDPOINT,
  });
  if (skipProofs) network.proofsEnabled = false;
  Mina.setActiveInstance(network);
}

let compileSucceeded = false;

async function compileContract(): Promise<boolean> {
  if (compileSucceeded) return true;

  if (!compilePromise) {
    compilePromise = (async () => {
      configureNetwork();
      await MinaGuard.compile();
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
      proposalCounter: Number(zkApp.proposalCounter.get().toString()),
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

  // Log send errors if any
  if ((result as any).errors?.length) {
    console.error('[MultisigWorker] Transaction send errors:', (result as any).errors);
  }
  if ((result as any).status === 'rejected') {
    console.error('[MultisigWorker] Transaction was rejected by the node');
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
      if (typeof proposalHash === 'string') {
        approvalStore.setCount(Field(proposalHash), EXECUTED_MARKER);
      }
    }
  }

  return { ownerStore, approvalStore, nullifierStore };
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
  return Field(4);
}

function buildProposalDataField(input: NewProposalInput): InstanceType<typeof Field> {
  if (input.txType === 'changeThreshold') {
    return Field(input.newThreshold ?? 0);
  }
  if (input.txType === 'addOwner' && input.newOwner) {
    return ownerKey(PublicKey.fromBase58(input.newOwner));
  }
  if (input.txType === 'removeOwner' && input.removeOwnerAddress) {
    return ownerKey(PublicKey.fromBase58(input.removeOwnerAddress));
  }
  if (input.txType === 'setDelegate') {
    if (input.undelegate) return Field(0);
    if (input.delegate) {
      return ownerKey(PublicKey.fromBase58(input.delegate));
    }
  }
  return Field(0);
}

function buildTransferReceivers(
  receivers: Array<{ address: string; amount: string }>
): InstanceType<typeof Receiver>[] {
  const normalized = receivers.map((receiver) => new Receiver({
    address: PublicKey.fromBase58(receiver.address),
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
    'receivers' | 'toAddress' | 'amount' | 'tokenId' | 'txType' | 'data' | 'uid' | 'configNonce' | 'expiryBlock' | 'networkId' | 'guardAddress'
  >,
  fallbackGuardAddress: string
): InstanceType<typeof TransactionProposal> {
  const txType = normalizeTxType(proposal.txType);
  const receivers = proposal.receivers.length > 0
    ? proposal.receivers
    : txType === 'transfer' && proposal.toAddress && proposal.amount
      ? [{ address: proposal.toAddress, amount: proposal.amount }]
      : [];
  return new TransactionProposal({
    receivers: buildTransferReceivers(receivers),
    tokenId: Field(proposal.tokenId ?? '0'),
    txType: txType ? uiTxTypeToField(txType) : Field(0),
    data: Field(proposal.data ?? '0'),
    uid: Field(proposal.uid ?? '0'),
    configNonce: Field(proposal.configNonce ?? '0'),
    expiryBlock: Field(proposal.expiryBlock ?? '0'),
    networkId: Field(proposal.networkId ?? '0'),
    guardAddress: safePublicKey(proposal.guardAddress ?? fallbackGuardAddress),
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
    console.error('[MultisigWorker] sendZkapp error:', error);
    return null;
  }
  return response?.data?.sendZkapp?.zkapp?.hash ?? null;
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

  generateKeypair(): { privateKey: string; publicKey: string } {
    const key = PrivateKey.random();
    return { privateKey: key.toBase58(), publicKey: key.toPublicKey().toBase58() };
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
    await tx.prove();

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
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

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
    await tx.prove();

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
    await tx.prove();

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const txHash = await submitTx(tx, sendFn, signFeePayerFn);
    console.log('[MultisigWorker] setup tx result:', txHash);
    return `Transaction submitted: ${txHash}`;
  },

  /**
   * Creates an offchain proposal in the backend and submits the proposer's
   * signature as the first approval.  No on-chain transaction is sent.
   * Returns the proposal hash string on success.
   */
  async createOffchainProposal(
    params: {
      contractAddress: string;
      proposerAddress: string;
      input: NewProposalInput;
      configNonce: number;
      networkId: string;
    },
    signFn: SignFieldsFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn('Computing proposal hash...');
    configureNetwork();
    const transferReceivers =
      params.input.txType === 'transfer'
        ? buildTransferReceivers(params.input.receivers ?? [])
        : buildTransferReceivers([]);

    const txType = uiTxTypeToField(params.input.txType);
    const data = buildProposalDataField(params.input);
    const uid = Field.random();

    const proposal = new TransactionProposal({
      receivers: transferReceivers,
      tokenId: Field(0),
      txType,
      data,
      uid,
      configNonce: Field(params.configNonce),
      expiryBlock: Field(params.input.expiryBlock ?? 0),
      networkId: Field(params.networkId),
      guardAddress: PublicKey.fromBase58(params.contractAddress),
    });

    const proposalHash = proposal.hash();
    const hashStr = proposalHash.toString();

    // Sign before submitting to avoid orphaned proposals if the user refuses
    progressFn(testPrivateKey ? 'Signing proposal hash...' : 'Awaiting wallet signature...');
    const signature = await signProposalHash(hashStr, signFn);
    if (!signature) return null;

    progressFn('Submitting proposal to backend...');
    await postOffchainProposal(params.contractAddress, {
      receivers: params.input.txType === 'transfer' ? (params.input.receivers ?? []) : undefined,
      toAddress:
        params.input.txType === 'addOwner'
          ? params.input.newOwner
          : params.input.txType === 'removeOwner'
            ? params.input.removeOwnerAddress
            : params.input.txType === 'setDelegate' && !params.input.undelegate
              ? params.input.delegate
              : PublicKey.empty().toBase58(),
      amount: params.input.txType === 'transfer' ? undefined : '0',
      tokenId: '0',
      txType: txType.toString(),
      data: data.toString(),
      uid: uid.toString(),
      configNonce: params.configNonce.toString(),
      expiryBlock: (params.input.expiryBlock ?? 0).toString(),
      networkId: params.networkId,
      guardAddress: params.contractAddress,
      proposalHash: hashStr,
      proposer: params.proposerAddress,
    });

    progressFn('Submitting signature to backend...');
    const sigJson = signature.toJSON();
    await postSignature(params.contractAddress, hashStr, {
      signer: params.proposerAddress,
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    return hashStr;
  },

  /**
   * Signs the proposal hash and submits the signature to the backend.
   * No on-chain transaction is sent.
   * Returns a JSON string with { approvalCount, threshold, ready }.
   */
  async submitOffchainSignature(
    params: {
      contractAddress: string;
      signerAddress: string;
      proposalHash: string;
    },
    signFn: SignFieldsFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn(testPrivateKey ? 'Signing proposal hash...' : 'Awaiting wallet signature...');
    configureNetwork();

    const signature = await signProposalHash(params.proposalHash, signFn);
    if (!signature) return null;

    progressFn('Submitting signature to backend...');
    const sigJson = signature.toJSON();
    const result = await postSignature(params.contractAddress, params.proposalHash, {
      signer: params.signerAddress,
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    if (!result) return null;
    return `Signature submitted (${result.approvalCount}/${result.threshold} approvals)`;
  },

  /**
   * Fetches the aggregated batch payload from the backend, compiles the
   * contract, builds the appropriate execute*BatchSig transaction, proves
   * and sends it on-chain.
   */
  async executeBatchTx(
    params: {
      contractAddress: string;
      executorAddress: string;
      proposal: Proposal;
    },
    sendFn: SendTxFn | null,
    progressFn: ProgressFn,
    signFeePayerFn?: SignFeePayerFn
  ): Promise<string | null> {
    progressFn('Fetching batch payload...');
    const payload = await fetchBatchPayload(
      params.contractAddress,
      params.proposal.proposalHash
    );
    if (!payload) {
      console.error('[MultisigWorker] Failed to fetch batch payload');
      return null;
    }
    if (!payload.ready) {
      console.error('[MultisigWorker] Batch payload not ready — insufficient signatures');
      return null;
    }

    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Fetching on-chain state...');
    const contractState = await fetchContractState(params.contractAddress);
    if (!contractState) return null;

    progressFn('Rebuilding stores...');
    const { ownerStore, approvalStore } = await rebuildStoresFromBackend(params.contractAddress);

    // Build TransactionProposal struct from the proposal record
    const txType = normalizeTxType(params.proposal.txType);
    const proposalStruct = buildProposalStruct({
      ...params.proposal,
      configNonce: params.proposal.configNonce ?? String(contractState.configNonce),
      networkId: params.proposal.networkId ?? contractState.networkId,
      guardAddress: params.proposal.guardAddress ?? params.contractAddress,
    }, params.contractAddress);

    const proposalHash = proposalStruct.hash();
    const approvalWitness = approvalStore.getWitness(proposalHash);

    // Build SignatureInputs using ownerStore order (matches ownersCommitment),
    // looking up signatures from payload by address.
    const dummySig = Signature.fromFields([Field(1), Field(1), Field(1)]);
    const dummyPk = PublicKey.fromFields([Field(1), Field(1)]);
    const sigByAddress = new Map(
      payload.inputs
        .filter((s) => s.isSome && s.signer && s.hasSignature)
        .map((s) => [s.signer!, { r: s.signatureR!, s: s.signatureS! }])
    );
    const orderedSlots: Array<{ isSome: boolean; signer: string | null; hasSignature: boolean; signatureR: string | null; signatureS: string | null }> =
      ownerStore.owners.map((pk) => {
        const addr = pk.toBase58();
        const sig = sigByAddress.get(addr);
        return { isSome: true, signer: addr, hasSignature: !!sig, signatureR: sig?.r ?? null, signatureS: sig?.s ?? null };
      });
    while (orderedSlots.length < MAX_OWNERS) {
      orderedSlots.push({ isSome: false, signer: null, hasSignature: false, signatureR: null, signatureS: null });
    }
    const sigInputs = new SignatureInputs({
      inputs: orderedSlots.map((slot) => {
        if (!slot.isSome) {
          return new SignatureInput({
            value: {
              signature: new SignatureOption({ value: dummySig, isSome: Bool(false) }),
              signer: dummyPk,
            },
            isSome: Bool(false),
          });
        }
        const signer = PublicKey.fromBase58(slot.signer!);
        if (slot.hasSignature) {
          const sig = Signature.fromJSON({ r: slot.signatureR!, s: slot.signatureS! });
          return new SignatureInput({
            value: {
              signature: new SignatureOption({ value: sig, isSome: Bool(true) }),
              signer,
            },
            isSome: Bool(true),
          });
        }
        return new SignatureInput({
          value: {
            signature: new SignatureOption({ value: dummySig, isSome: Bool(false) }),
            signer,
          },
          isSome: Bool(true),
        });
      }),
    });

    progressFn('Building transaction...');
    const contract = new MinaGuard(PublicKey.fromBase58(params.contractAddress));
    const executor = PublicKey.fromBase58(params.executorAddress);

    await fetchAccount({ publicKey: executor });
    clearStaleTransaction();
    const tx = await Mina.transaction(txSender(executor), async () => {
      if (txType === 'transfer') {
        await contract.executeTransferBatchSig(proposalStruct, approvalWitness, sigInputs);
        return;
      }

      if (txType === 'addOwner' || txType === 'removeOwner') {
        if (!params.proposal.toAddress) {
          throw new Error('Proposal toAddress is required for owner change execution');
        }
        const owner = PublicKey.fromBase58(params.proposal.toAddress);
        const pred = ownerStore.sortedPredecessor(owner);
        const insertAfter =
          txType === 'addOwner' && pred
            ? new PublicKeyOption({ value: pred, isSome: Bool(true) })
            : PublicKeyOption.none();
        await contract.executeOwnerChangeBatchSig(
          proposalStruct, approvalWitness, sigInputs, owner, ownerStore.getWitness(), insertAfter
        );
        return;
      }

      if (txType === 'changeThreshold') {
        await contract.executeThresholdChangeBatchSig(
          proposalStruct, approvalWitness, sigInputs, Field(params.proposal.data ?? '0')
        );
        return;
      }

      if (txType === 'setDelegate') {
        const delegate =
          params.proposal.data === '0'
            ? PublicKey.empty()
            : PublicKey.fromBase58(params.proposal.toAddress ?? '');
        await contract.executeDelegateBatchSig(
          proposalStruct, approvalWitness, sigInputs, delegate
        );
        return;
      }

      throw new Error('Unsupported proposal type for batch execution');
    });

    progressFn('Generating proof...');
    await tx.prove();

    progressFn(testPrivateKey ? 'Signing and sending transaction...' : 'Submitting transaction...');
    const executeHash = await submitTx(tx, sendFn, signFeePayerFn);
    return `Transaction submitted: ${executeHash}`;
  },
};

export type WorkerApi = typeof workerApi;

// Eagerly start compilation as soon as the worker loads
compileContract().catch(() => { });

Comlink.expose(workerApi);
