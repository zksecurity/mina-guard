// -- Multisig Contract Worker ------------------------------------------
// Runs o1js compilation and proof generation off the main thread.

import * as Comlink from 'comlink';

import {
  Mina,
  Field,
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
} from 'contracts';

import {
  type NewProposalInput,
  type Proposal,
  normalizeTxType,
} from '@/lib/types';
import { fetchAllEvents } from './api';

/** Callback type for sending a signed transaction via Auro wallet on the main thread. */
type SendTxFn = (txJson: string) => Promise<string | null>;

/** Callback type for requesting a field signature from Auro wallet on the main thread. */
type SignFieldsFn = (
  fields: Array<string | number>
) => Promise<{ data: Array<string | number>; signature: string } | null>;

/** Callback type for reporting step-based progress to the main thread. */
type ProgressFn = (step: string) => void;

// const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'https://api.minascan.io/node/devnet/v1/graphql';
// const ARCHIVE_ENDPOINT = process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT ?? 'https://api.minascan.io/archive/devnet/v1/graphql';
const MINA_ENDPOINT = 'http://127.0.0.1:8080/graphql';
const ARCHIVE_ENDPOINT = 'http://127.0.0.1:8282';

let compilePromise: Promise<void> | null = null;

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
  Mina.setActiveInstance(
    Mina.Network({
      mina: MINA_ENDPOINT,
      archive: ARCHIVE_ENDPOINT,
    })
  );
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
  const signed = await signFn([hashAsFieldString]);
  if (!signed?.signature) return null;
  try {
    return Signature.fromBase58(signed.signature);
  } catch {
    return null;
  }
}

async function rebuildStoresFromBackend(contractAddress: string) {
  const ownerStore = new OwnerStore();
  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();
  const events = await fetchAllEvents(contractAddress);

  for (const event of events) {
    if (event.eventType === 'setupOwner') {
      const payload = event.payload as Record<string, unknown>;
      const owner = payload.owner;
      const emptyKey = PublicKey.empty().toBase58();
      console.log("emptyKey: ", emptyKey);
      console.log("payload.owner: ", payload.owner);
      if (typeof owner === 'string' && owner.length > 10 && owner !== emptyKey) {
        ownerStore.add(PublicKey.fromBase58(owner));
      }
      continue;
    }

    if (event.eventType === 'ownerChange') {
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

    if (event.eventType === 'execution') {
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

async function buildProposalAndStores(params: {
  contractAddress: string;
  contractState: ContractState;
  input: NewProposalInput;
}) {
  const { ownerStore, approvalStore, nullifierStore } =
    await rebuildStoresFromBackend(params.contractAddress);

  const to =
    params.input.txType === 'transfer' && params.input.to
      ? PublicKey.fromBase58(params.input.to)
      : PublicKey.empty();

  const amount =
    params.input.txType === 'transfer'
      ? UInt64.from(
          Math.floor(Number(params.input.amount ?? '0') * 1_000_000_000)
        )
      : UInt64.from(0);

  const txType = uiTxTypeToField(params.input.txType);
  const data = buildProposalDataField(params.input);

  const proposal = new TransactionProposal({
    to,
    amount,
    tokenId: Field(0),
    txType,
    data,
    uid: Field(params.contractState.proposalCounter),
    configNonce: Field(params.contractState.configNonce),
    expiryBlock: Field(params.input.expiryBlock ?? 0),
    networkId: Field(params.contractState.networkId),
    guardAddress: PublicKey.fromBase58(params.contractAddress),
  });

  return { proposal, ownerStore, approvalStore, nullifierStore };
}

async function buildStoresForExistingProposal(
  contractAddress: string,
  proposal: Proposal,
  contractState: ContractState
) {
  const stores = await rebuildStoresFromBackend(contractAddress);
  const txType = proposal.txType
    ? uiTxTypeToField(proposal.txType)
    : Field(0);

  const proposalStruct = new TransactionProposal({
    to: safePublicKey(proposal.toAddress),
    amount: UInt64.from(proposal.amount ?? '0'),
    tokenId: Field(proposal.tokenId ?? '0'),
    txType,
    data: Field(proposal.data ?? '0'),
    uid: Field(proposal.uid ?? '0'),
    configNonce: Field(proposal.configNonce ?? contractState.configNonce),
    expiryBlock: Field(proposal.expiryBlock ?? '0'),
    networkId: Field(proposal.networkId ?? contractState.networkId),
    guardAddress: safePublicKey(proposal.guardAddress ?? contractAddress),
  });

  return {
    proposalStruct,
    ownerStore: stores.ownerStore,
    approvalStore: stores.approvalStore,
    nullifierStore: stores.nullifierStore,
  };
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

    const tx = await Mina.transaction(feePayer, async () => {
      AccountUpdate.fundNewAccount(feePayer);
      await zkApp.deploy();
    });

    progressFn('Generating proof...');
    await tx.prove();
    tx.sign([zkAppKey]);

    progressFn('Submitting transaction...');
    const deployHash = await sendFn(serializeTx(tx));
    return deployHash;
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

    const tx = await Mina.transaction(feePayer, async () => {
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

    progressFn('Submitting transaction...');
    const txHash = await sendFn(serializeTx(tx));
    console.log('[MultisigWorker] setup tx result:', txHash);
    return txHash;
  },

  async createProposeTx(
    params: {
      contractAddress: string;
      proposerAddress: string;
      input: NewProposalInput;
    },
    signFn: SignFieldsFn,
    sendFn: SendTxFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Fetching on-chain state...');
    const contractState = await fetchContractState(params.contractAddress);
    if (!contractState) return null;

    progressFn('Rebuilding stores from events...');
    const { proposal, ownerStore, approvalStore, nullifierStore } =
      await buildProposalAndStores({
        contractAddress: params.contractAddress,
        contractState,
        input: params.input,
      });

    progressFn('Awaiting wallet signature...');
    const proposer = PublicKey.fromBase58(params.proposerAddress);
    const signature = await signProposalHash(
      proposal.hash().toString(),
      signFn
    );
    if (!signature) return null;

    progressFn('Building transaction...');
    const contract = new MinaGuard(
      PublicKey.fromBase58(params.contractAddress)
    );
    const proposalHash = proposal.hash();

    const tx = await Mina.transaction(proposer, async () => {
      await contract.propose(
        proposal,
        ownerStore.getWitness(),
        proposer,
        signature,
        nullifierStore.getWitness(proposalHash, proposer),
        approvalStore.getWitness(proposalHash)
      );
    });

    progressFn('Generating proof...');
    await tx.prove();

    progressFn('Submitting transaction...');
    const proposeHash = await sendFn(serializeTx(tx));
    return proposeHash;
  },

  async createApproveTx(
    params: {
      contractAddress: string;
      approverAddress: string;
      proposal: Proposal;
    },
    signFn: SignFieldsFn,
    sendFn: SendTxFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Fetching on-chain state...');
    const contractState = await fetchContractState(params.contractAddress);
    if (!contractState) return null;

    progressFn('Rebuilding stores from events...');
    const { proposalStruct, ownerStore, approvalStore, nullifierStore } =
      await buildStoresForExistingProposal(
        params.contractAddress,
        params.proposal,
        contractState
      );

    progressFn('Awaiting wallet signature...');
    const approver = PublicKey.fromBase58(params.approverAddress);
    const proposalHash = proposalStruct.hash();

    const signature = await signProposalHash(
      proposalHash.toString(),
      signFn
    );
    if (!signature) return null;

    progressFn('Building transaction...');
    const currentApprovalCount = approvalStore.getCount(proposalHash);
    const contract = new MinaGuard(
      PublicKey.fromBase58(params.contractAddress)
    );

    const tx = await Mina.transaction(approver, async () => {
      await contract.approveProposal(
        proposalStruct,
        signature,
        approver,
        ownerStore.getWitness(),
        approvalStore.getWitness(proposalHash),
        currentApprovalCount,
        nullifierStore.getWitness(proposalHash, approver)
      );
    });

    progressFn('Generating proof...');
    await tx.prove();

    progressFn('Submitting transaction...');
    const approveHash = await sendFn(serializeTx(tx));
    return approveHash;
  },

  async createExecuteTx(
    params: {
      contractAddress: string;
      executorAddress: string;
      proposal: Proposal;
      overrides?: { ownerAddress?: string; delegateAddress?: string };
    },
    sendFn: SendTxFn,
    progressFn: ProgressFn
  ): Promise<string | null> {
    progressFn('Compiling contract...');
    const ok = await compileContract();
    if (!ok) return null;

    progressFn('Fetching on-chain state...');
    const contractState = await fetchContractState(params.contractAddress);
    if (!contractState) return null;

    progressFn('Rebuilding stores from events...');
    const { proposalStruct, ownerStore, approvalStore } =
      await buildStoresForExistingProposal(
        params.contractAddress,
        params.proposal,
        contractState
      );

    progressFn('Building transaction...');
    const proposalHash = proposalStruct.hash();
    const approvalCount = approvalStore.getCount(proposalHash);
    const contract = new MinaGuard(
      PublicKey.fromBase58(params.contractAddress)
    );
    const executor = PublicKey.fromBase58(params.executorAddress);
    const txType = normalizeTxType(params.proposal.txType);
    console.log("txType: ", txType);

    const tx = await Mina.transaction(executor, async () => {
      if (txType === 'transfer') {
        await contract.executeTransfer(
          proposalStruct,
          approvalStore.getWitness(proposalHash),
          approvalCount
        );
        return;
      }

      if (txType === 'addOwner' || txType === 'removeOwner') {
        if (!params.overrides?.ownerAddress) {
          throw new Error(
            'ownerAddress override is required for owner change execution'
          );
        }
        const owner = PublicKey.fromBase58(params.overrides.ownerAddress);
        await contract.executeOwnerChange(
          proposalStruct,
          approvalStore.getWitness(proposalHash),
          approvalCount,
          owner,
          ownerStore.getWitness()
        );
        return;
      }

      if (txType === 'changeThreshold') {
        await contract.executeThresholdChange(
          proposalStruct,
          approvalStore.getWitness(proposalHash),
          approvalCount,
          Field(params.proposal.data ?? '0')
        );
        return;
      }

      if (txType === 'setDelegate') {
        const delegate =
          params.proposal.data === '0'
            ? PublicKey.empty()
            : PublicKey.fromBase58(params.overrides?.delegateAddress ?? '');
        await contract.executeDelegate(
          proposalStruct,
          approvalStore.getWitness(proposalHash),
          approvalCount,
          delegate
        );
        return;
      }

      throw new Error('Unsupported proposal type for execution');
    });

    progressFn('Generating proof...');
    await tx.prove();

    progressFn('Submitting transaction...');
    const executeHash = await sendFn(serializeTx(tx));
    return executeHash;
  },
};

export type WorkerApi = typeof workerApi;

Comlink.expose(workerApi);
