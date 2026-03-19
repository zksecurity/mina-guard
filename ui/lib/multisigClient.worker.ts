// -- Multisig Contract Worker ------------------------------------------
// Runs o1js compilation and proof generation off the main thread.

import * as Comlink from 'comlink';

import {
  Mina,
  Field,
  Bool,
  UInt64,
  fetchAccount,
  AccountUpdate,
  PublicKey,
  PrivateKey,
  Signature,
} from 'o1js';
import {
  MinaGuard,
  TransactionProposal,
  ownerKey,
  EXECUTED_MARKER,
  PROPOSED_MARKER,
  MAX_OWNERS,
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

/** Callback type for requesting a field signature from Auro wallet on the main thread. */
type SignFieldsFn = (
  fields: Array<string | number>
) => Promise<{ data: Array<string | number>; signature: string } | null>;

/** Callback type for reporting step-based progress to the main thread. */
type ProgressFn = (step: string) => void;

const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'https://api.minascan.io/node/devnet/v1/graphql';
const ARCHIVE_ENDPOINT = process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT ?? 'https://api.minascan.io/archive/devnet/v1/graphql';

let compilePromise: Promise<void> | null = null;

// -- E2E test mode --------------------------------------------------------
// When a test private key is set, the worker signs and sends transactions
// directly instead of delegating to the Auro wallet on the main thread.
let testPrivateKey: InstanceType<typeof PrivateKey> | null = null;
let skipProofs = false;
const DEFAULT_FEE = 100_000_000; // 0.1 MINA — used when sending directly (test mode)

/** Returns Mina.transaction sender arg — includes fee in test mode since Auro won't set it. */
function txSender(pub: InstanceType<typeof PublicKey>) {
  return testPrivateKey ? { sender: pub, fee: DEFAULT_FEE } : pub;
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

async function compileContract(): Promise<boolean> {
  if (compilePromise) {
    await compilePromise;
    return true;
  }

  compilePromise = (async () => {
    configureNetwork();
    await MinaGuard.compile();
  })();

  try {
    await compilePromise;
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
    return Signature.fromBase58(signed.signature);
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

  // Process setupOwner events sorted by index — the archive may return events
  // within the same transaction in arbitrary order, which would cause an
  // incorrect ownerChain hash that doesn't match ownersCommitment on-chain.
  const emptyKey = PublicKey.empty().toBase58();
  const setupOwnerEntries = events
    .filter(e => e.eventType === 'setupOwner')
    .map(e => {
      const p = e.payload as Record<string, unknown>;
      return { index: Number(p.index ?? 0), owner: p.owner };
    })
    .filter(({ owner }) => typeof owner === 'string' && (owner as string).length > 10 && owner !== emptyKey)
    .sort((a, b) => a.index - b.index);
  for (const { owner } of setupOwnerEntries) {
    ownerStore.add(PublicKey.fromBase58(owner as string));
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
          ownerStore.add(PublicKey.fromBase58(owner));
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

function uiTxTypeToField(type: string): any {
  if (type === 'transfer') return Field(0);
  if (type === 'addOwner') return Field(1);
  if (type === 'removeOwner') return Field(2);
  if (type === 'changeThreshold') return Field(3);
  return Field(4);
}

function buildProposalDataField(input: NewProposalInput): any {
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

/** Safely serializes tx.toJSON() regardless of whether it returns a string or object. */
function serializeTx(tx: Awaited<ReturnType<typeof Mina.transaction>>): string {
  const json = tx.toJSON();
  return typeof json === 'string' ? json : JSON.stringify(json);
}

// ---------------------------------------------------------------------------
// Public worker API exposed via Comlink
// ---------------------------------------------------------------------------

const workerApi = {
  /** Sets the private key for e2e test mode (direct sign/send, no Auro). */
  setTestKey(privateKeyBase58: string) {
    testPrivateKey = PrivateKey.fromBase58(privateKeyBase58);
  },

  /** Disables proof generation (for use with lightnet / test environments). */
  setSkipProofs(skip: boolean) {
    skipProofs = skip;
  },

  generateKeypair(): { privateKey: string; publicKey: string } {
    const key = PrivateKey.random();
    return { privateKey: key.toBase58(), publicKey: key.toPublicKey().toBase58() };
  },

  async deployContract(
    params: { feePayerAddress: string; zkAppPrivateKeyBase58: string },
    sendFn: SendTxFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Building transaction...');
    const feePayer = PublicKey.fromBase58(params.feePayerAddress);
    const zkAppKey = PrivateKey.fromBase58(params.zkAppPrivateKeyBase58);
    const zkAppAddress = zkAppKey.toPublicKey();
    const zkApp = new MinaGuard(zkAppAddress);

    const tx = await Mina.transaction(txSender(feePayer), async () => {
      AccountUpdate.fundNewAccount(feePayer);
      await zkApp.deploy();
    });

    progressFn('Generating proof...');
    await tx.prove();

    if (testPrivateKey) {
      progressFn('Signing and sending transaction...');
      return await signAndSend(tx, [zkAppKey]);
    }

    tx.sign([zkAppKey]);
    progressFn('Submitting transaction...');
    const deployHash = await sendFn(serializeTx(tx));
    return `Transaction submitted: ${deployHash}`;
  },

  async setupContract(
    params: {
      zkAppAddress: string;
      feePayerAddress: string;
      owners: string[];
      threshold: number;
      networkId: string;
    },
    sendFn: SendTxFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Building transaction...');
    const ownerStore = new OwnerStore();
    const ownerKeys = params.owners.map((address) =>
      PublicKey.fromBase58(address)
    );
    for (const owner of ownerKeys) ownerStore.add(owner);

    const paddedOwners = [...ownerKeys];
    while (paddedOwners.length < MAX_OWNERS) {
      paddedOwners.push(PublicKey.empty());
    }

    const zkAppAddress = PublicKey.fromBase58(params.zkAppAddress);
    const feePayer = PublicKey.fromBase58(params.feePayerAddress);
    const zkApp = new MinaGuard(zkAppAddress);

    const tx = await Mina.transaction(txSender(feePayer), async () => {
      await zkApp.setup(
        ownerStore.getCommitment(),
        Field(params.threshold),
        Field(ownerKeys.length),
        Field(params.networkId),
        new SetupOwnersInput({
          owners: paddedOwners.slice(0, MAX_OWNERS),
        })
      );
    });

    progressFn('Generating proof...');
    await tx.prove();

    if (testPrivateKey) {
      progressFn('Signing and sending transaction...');
      const txHash = await signAndSend(tx);
      console.log('[MultisigWorker] setup tx result:', txHash);
      return txHash;
    }

    progressFn('Submitting transaction...');
    const txHash = await sendFn(serializeTx(tx));
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

    const to = (() => {
      if (params.input.txType === 'transfer' && params.input.to)
        return PublicKey.fromBase58(params.input.to);
      if (params.input.txType === 'addOwner' && params.input.newOwner)
        return PublicKey.fromBase58(params.input.newOwner);
      if (params.input.txType === 'removeOwner' && params.input.removeOwnerAddress)
        return PublicKey.fromBase58(params.input.removeOwnerAddress);
      if (params.input.txType === 'setDelegate' && params.input.delegate)
        return PublicKey.fromBase58(params.input.delegate);
      return PublicKey.empty();
    })();

    const amount =
      params.input.txType === 'transfer'
        ? UInt64.from(Math.floor(Number(params.input.amount ?? '0') * 1_000_000_000))
        : UInt64.from(0);

    const txType = uiTxTypeToField(params.input.txType);
    const data = buildProposalDataField(params.input);
    const uid = Field.random();

    const proposal = new TransactionProposal({
      to,
      amount,
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

    progressFn('Submitting proposal to backend...');
    await postOffchainProposal(params.contractAddress, {
      toAddress: to.toBase58(),
      amount: amount.toString(),
      tokenId: '0',
      txType: txType.toString(),
      data: data.toString(),
      uid: uid.toString(),
      configNonce: params.configNonce.toString(),
      expiryBlock: (params.input.expiryBlock ?? 0).toString(),
      networkId: params.networkId,
      guardAddress: params.contractAddress,
      proposalHash: hashStr,
    });

    // Also submit the proposer's signature as first approval
    progressFn(testPrivateKey ? 'Signing proposal hash...' : 'Awaiting wallet signature...');
    const signature = await signProposalHash(hashStr, signFn);
    if (!signature) return null;

    progressFn('Submitting signature to backend...');
    const sigJson = signature.toJSON();
    await postSignature(params.contractAddress, hashStr, {
      signer: params.proposerAddress,
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    return 'Proposal created';
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
    sendFn: SendTxFn,
    progressFn: ProgressFn
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
    const proposalStruct = new TransactionProposal({
      to: safePublicKey(params.proposal.toAddress),
      amount: UInt64.from(params.proposal.amount ?? '0'),
      tokenId: Field(params.proposal.tokenId ?? '0'),
      txType: txType ? uiTxTypeToField(txType) : Field(0),
      data: Field(params.proposal.data ?? '0'),
      uid: Field(params.proposal.uid ?? '0'),
      configNonce: Field(params.proposal.configNonce ?? contractState.configNonce),
      expiryBlock: Field(params.proposal.expiryBlock ?? '0'),
      networkId: Field(params.proposal.networkId ?? contractState.networkId),
      guardAddress: safePublicKey(params.proposal.guardAddress ?? params.contractAddress),
    });

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
        const insertAfter =
          txType === 'addOwner' && ownerStore.length > 0
            ? new PublicKeyOption({ value: ownerStore.owners[ownerStore.length - 1], isSome: Bool(true) })
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

    if (testPrivateKey) {
      progressFn('Signing and sending transaction...');
      return await signAndSend(tx);
    }

    progressFn('Submitting transaction...');
    return `Transaction submitted: ${await sendFn(serializeTx(tx))}`;
  },
};

export type WorkerApi = typeof workerApi;

// Eagerly start compilation as soon as the worker loads
compileContract().catch(() => {});

Comlink.expose(workerApi);
