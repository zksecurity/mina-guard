// -- Multisig Contract Client -----------------------------------------
"use client";

import {
  Mina,
  Field,
  UInt64,
  fetchAccount,
  AccountUpdate,
  PublicKey,
  PrivateKey,
  Signature
} from "o1js";

import {
  MinaGuard,
  TransactionProposal,
  ownerKey,
  EXECUTED_MARKER,
  PROPOSED_MARKER,
  MAX_SETUP_OWNERS,
  SetupOwnersInput,
  OwnerStore,
  VoteNullifierStore,
  ApprovalStore
} from "contracts";

import {
  type NewProposalInput,
  type Proposal,
  normalizeTxType,
} from '@/lib/types';
import { getAuroSignFields, sendTransaction } from '@/lib/auroWallet';
import { fetchAllEvents } from "./api";

let compilePromise: Promise<void> | null = null;

/** DEFAULT ENDPOINTS */
// const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'https://api.minascan.io/node/devnet/v1/graphql';
// const ARCHIVE_ENDPOINT = process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT ?? 'https://api.minascan.io/archive/devnet/v1/graphql';
const MINA_ENDPOINT = "http://127.0.0.1:8080/graphql";
const ARCHIVE_ENDPOINT = "http://127.0.0.1:8282"

/** Contract state snapshot read directly from chain. */
export interface ContractState {
  ownersRoot: string;
  threshold: number;
  numOwners: number;
  proposalNonce: number;
  voteNullifierRoot: string;
  approvalRoot: string;
  configNonce: number;
  networkId: string;
}

/** Execution parameter overrides required for non-transfer execution methods. */
export interface ExecuteOverrides {
  ownerAddress?: string;
  delegateAddress?: string;
}

/** Configures Mina and archive endpoints for client-side chain access and event fetches. */
export async function configureNetwork() {
  Mina.setActiveInstance(
    Mina.Network({
      mina: MINA_ENDPOINT,
      archive: ARCHIVE_ENDPOINT
    })
  );
}

/** Compiles MinaGuard once and caches the compile promise for subsequent actions. */
export async function compileContract(): Promise<boolean> {
  if (compilePromise) {
    await compilePromise;
    return true;
  }

  compilePromise = (async () => {
    await configureNetwork();
    await MinaGuard.compile();
  })();

  try {
    await compilePromise;
    return true;
  } catch (error) {
    console.error('[MultisigClient] Contract compile failed', error);
    compilePromise = null;
    return false;
  }
}

/** Reads on-chain MinaGuard state fields used when constructing proposal payloads. */
export async function fetchContractState(contractAddress: string): Promise<ContractState | null> {
  try {
    await configureNetwork();

    const address = PublicKey.fromBase58(contractAddress);
    await fetchAccount({ publicKey: address });

    const zkApp = new MinaGuard(address);
    return {
      ownersRoot: zkApp.ownersRoot.get().toString(),
      threshold: Number(zkApp.threshold.get().toString()),
      numOwners: Number(zkApp.numOwners.get().toString()),
      proposalNonce: Number(zkApp.proposalNonce.get().toString()),
      voteNullifierRoot: zkApp.voteNullifierRoot.get().toString(),
      approvalRoot: zkApp.approvalRoot.get().toString(),
      configNonce: Number(zkApp.configNonce.get().toString()),
      networkId: zkApp.networkId.get().toString(),
    };
  } catch (error) {
    console.error('[MultisigClient] Failed to fetch contract state', error);
    return null;
  }
}

/**
 * Deploys MinaGuard contract account update and submits it through Auro.
 * The zkApp private key remains in browser memory for this call only.
 */
export async function deployContract(params: {
  feePayerAddress: string;
  zkAppPrivateKeyBase58: string;
}): Promise<string | null> {
  console.log("Deploying...");

  const ok = await compileContract();
  console.log("Contract compiled", ok);
  if (!ok) return null;

  const feePayer = PublicKey.fromBase58(params.feePayerAddress);
  const zkAppKey = PrivateKey.fromBase58(params.zkAppPrivateKeyBase58);
  const zkAppAddress = zkAppKey.toPublicKey();
  console.log("zkAppAddress", zkAppAddress);
  const zkApp = new MinaGuard(zkAppAddress);

  const tx = await Mina.transaction(feePayer, async () => {
    AccountUpdate.fundNewAccount(feePayer);
    await zkApp.deploy();
  });

  await tx.prove();
  tx.sign([zkAppKey]);

  const txJson = tx.toJSON();
  return sendTransaction(JSON.stringify(txJson));
}

/** Submits setup transaction with fixed-size owner list and threshold/network bootstrap. */
export async function setupContract(params: {
  zkAppAddress: string;
  feePayerAddress: string;
  owners: string[];
  threshold: number;
  networkId: string;
}): Promise<string | null> {
  const ok = await compileContract();
  if (!ok) return null;

  const ownerStore = new OwnerStore();
  const ownerKeys = params.owners.map((address) => PublicKey.fromBase58(address));
  for (const owner of ownerKeys) ownerStore.add(owner);

  const paddedOwners = [...ownerKeys];
  while (paddedOwners.length < MAX_SETUP_OWNERS) {
    paddedOwners.push(PublicKey.empty());
  }

  const zkAppAddress = PublicKey.fromBase58(params.zkAppAddress);
  const feePayer = PublicKey.fromBase58(params.feePayerAddress);
  const zkApp = new MinaGuard(zkAppAddress);

  const tx = await Mina.transaction(feePayer, async () => {
    await zkApp.setup(
      ownerStore.getRoot(),
      Field(params.threshold),
      Field(ownerKeys.length),
      Field(params.networkId),
      new SetupOwnersInput({
        owners: paddedOwners.slice(0, MAX_SETUP_OWNERS),
      })
    );
  });

  await tx.prove();
  return sendTransaction(JSON.stringify(tx.toJSON()));
}

/** Creates, proves, and sends a MinaGuard propose transaction using Auro field signature. */
export async function createProposeTx(params: {
  contractAddress: string;
  proposerAddress: string;
  input: NewProposalInput;
}): Promise<string | null> {
  const ok = await compileContract();
  if (!ok) return null;

  const contractState = await fetchContractState(params.contractAddress);
  if (!contractState) return null;

  const { proposal, ownerStore, approvalStore, nullifierStore } = await buildProposalAndStores({
    contractAddress: params.contractAddress,
    contractState,
    input: params.input,
  });

  const proposer = PublicKey.fromBase58(params.proposerAddress);
  const signature = await signProposalHash(proposal.hash().toString());
  if (!signature) return null;

  const contract = new MinaGuard(PublicKey.fromBase58(params.contractAddress));
  const proposalHash = proposal.hash();

  const tx = await Mina.transaction(proposer, async () => {
    await contract.propose(
      proposal,
      ownerStore.getWitness(proposer),
      proposer,
      signature,
      nullifierStore.getWitness(proposalHash, proposer),
      approvalStore.getWitness(proposalHash)
    );
  });

  await tx.prove();
  return sendTransaction(JSON.stringify(tx.toJSON()));
}

/** Creates, proves, and submits approveProposal transaction for selected proposal hash. */
export async function createApproveTx(params: {
  contractAddress: string;
  approverAddress: string;
  proposal: Proposal;
}): Promise<string | null> {
  const ok = await compileContract();
  if (!ok) return null;

  const contractState = await fetchContractState(params.contractAddress);
  if (!contractState) return null;

  const { proposalStruct, ownerStore, approvalStore, nullifierStore } =
    await buildStoresForExistingProposal(params.contractAddress, params.proposal, contractState);

  const approver = PublicKey.fromBase58(params.approverAddress);
  const proposalHash = proposalStruct.hash();

  const signature = await signProposalHash(proposalHash.toString());
  if (!signature) return null;

  const currentApprovalCount = approvalStore.getCount(proposalHash);
  const contract = new MinaGuard(PublicKey.fromBase58(params.contractAddress));

  const tx = await Mina.transaction(approver, async () => {
    await contract.approveProposal(
      proposalStruct,
      signature,
      approver,
      ownerStore.getWitness(approver),
      approvalStore.getWitness(proposalHash),
      currentApprovalCount,
      nullifierStore.getWitness(proposalHash, approver)
    );
  });

  await tx.prove();
  return sendTransaction(JSON.stringify(tx.toJSON()));
}

/** Creates, proves, and submits execution transaction for the selected proposal type. */
export async function createExecuteTx(params: {
  contractAddress: string;
  executorAddress: string;
  proposal: Proposal;
  overrides?: ExecuteOverrides;
}): Promise<string | null> {
  const ok = await compileContract();
  if (!ok) return null;

  const contractState = await fetchContractState(params.contractAddress);
  if (!contractState) return null;

  const { proposalStruct, ownerStore, approvalStore } = await buildStoresForExistingProposal(
    params.contractAddress,
    params.proposal,
    contractState
  );

  const proposalHash = proposalStruct.hash();
  const approvalCount = approvalStore.getCount(proposalHash);

  const contract = new MinaGuard(PublicKey.fromBase58(params.contractAddress));

  const executor = PublicKey.fromBase58(params.executorAddress);
  const txType = normalizeTxType(params.proposal.txType);

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
        throw new Error('ownerAddress override is required for owner change execution');
      }
      const owner = PublicKey.fromBase58(params.overrides.ownerAddress);
      await contract.executeOwnerChange(
        proposalStruct,
        approvalStore.getWitness(proposalHash),
        approvalCount,
        owner,
        ownerStore.getWitness(owner)
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
      const delegate = params.proposal.data === '0'
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

  await tx.prove();
  return sendTransaction(JSON.stringify(tx.toJSON()));
}

/** Rebuilds off-chain stores and proposal struct for creating a fresh proposal. */
async function buildProposalAndStores(params: {
  contractAddress: string;
  contractState: ContractState;
  input: NewProposalInput;
}) {

  const { ownerStore, approvalStore, nullifierStore } = await rebuildStoresFromBackend(
    params.contractAddress
  );

  const to = params.input.txType === 'transfer' && params.input.to
    ? PublicKey.fromBase58(params.input.to)
    : PublicKey.empty();

  const amount = params.input.txType === 'transfer'
    ? UInt64.from(Math.floor(Number(params.input.amount ?? '0') * 1_000_000_000))
    : UInt64.from(0);

  const txType = uiTxTypeToField(params.input.txType, Field);

  const data = buildProposalDataField(params.input, PublicKey, Field);

  const proposal = new TransactionProposal({
    to,
    amount,
    tokenId: Field(0),
    txType,
    data,
    nonce: Field(params.contractState.proposalNonce),
    configNonce: Field(params.contractState.configNonce),
    expiryBlock: Field(params.input.expiryBlock ?? 0),
    networkId: Field(params.contractState.networkId),
    guardAddress: PublicKey.fromBase58(params.contractAddress),
  });

  return { proposal, ownerStore, approvalStore, nullifierStore };
}

/** Rebuilds stores and proposal struct for approval/execution on existing proposals. */
async function buildStoresForExistingProposal(
  contractAddress: string,
  proposal: Proposal,
  contractState: ContractState
) {

  const stores = await rebuildStoresFromBackend(contractAddress);
  const txType = proposal.txType ? uiTxTypeToField(proposal.txType, Field) : Field(0);

  const proposalStruct = new TransactionProposal({
    to: proposal.toAddress ? PublicKey.fromBase58(proposal.toAddress) : PublicKey.empty(),
    amount: UInt64.from(proposal.amount ?? '0'),
    tokenId: Field(proposal.tokenId ?? '0'),
    txType,
    data: Field(proposal.data ?? '0'),
    nonce: Field(proposal.nonce ?? '0'),
    configNonce: Field(proposal.configNonce ?? contractState.configNonce),
    expiryBlock: Field(proposal.expiryBlock ?? '0'),
    networkId: Field(proposal.networkId ?? contractState.networkId),
    guardAddress: PublicKey.fromBase58(proposal.guardAddress ?? contractAddress),
  });

  return {
    proposalStruct,
    ownerStore: stores.ownerStore,
    approvalStore: stores.approvalStore,
    nullifierStore: stores.nullifierStore,
  };
}

/** Reconstructs owner/approval/nullifier stores from indexed backend event history. */
async function rebuildStoresFromBackend(contractAddress: string) {

  const ownerStore = new OwnerStore();
  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();

  const events = await fetchAllEvents(contractAddress);

  for (const event of events) {
    if (event.eventType === 'setupOwner') {
      const payload = event.payload as Record<string, unknown>;
      const owner = payload.owner;
      const active = payload.active;
      if (typeof owner === 'string' && owner.length > 10 && (active === '1' || active === 1 || active === true)) {
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
      if (typeof proposalHash === 'string') {
        approvalStore.setCount(Field(proposalHash), PROPOSED_MARKER.add(1));
      }
      continue;
    }

    if (event.eventType === 'approval') {
      const payload = event.payload as Record<string, unknown>;
      const proposalHash = payload.proposalHash;
      const approver = payload.approver;
      const approvalCount = payload.approvalCount;

      if (typeof proposalHash === 'string' && typeof approvalCount === 'string') {
        approvalStore.setCount(Field(proposalHash), Field(approvalCount));
      }

      if (typeof proposalHash === 'string' && typeof approver === 'string' && approver.length > 10) {
        nullifierStore.nullify(Field(proposalHash), PublicKey.fromBase58(approver));
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

/** Maps UI tx type values into on-chain Field enum values. */
function uiTxTypeToField(type: string, FieldCtor: (value: string | number) => unknown): any {
  if (type === 'transfer') return FieldCtor(0);
  if (type === 'addOwner') return FieldCtor(1);
  if (type === 'removeOwner') return FieldCtor(2);
  if (type === 'changeThreshold') return FieldCtor(3);
  return FieldCtor(4);
}

/** Builds on-chain proposal `data` field according to tx type-specific payload rules. */
function buildProposalDataField(
  input: NewProposalInput,
  PublicKeyCtor: { fromBase58: (value: string) => any },
  FieldCtor: (value: string | number) => any
): any {
  if (input.txType === 'changeThreshold') {
    return FieldCtor(input.newThreshold ?? 0);
  }

  if (input.txType === 'addOwner' && input.newOwner) {
    return ownerKey(PublicKeyCtor.fromBase58(input.newOwner));
  }

  if (input.txType === 'removeOwner' && input.removeOwnerAddress) {
    return ownerKey(PublicKeyCtor.fromBase58(input.removeOwnerAddress));
  }

  if (input.txType === 'setDelegate') {
    if (input.undelegate) return FieldCtor(0);
    if (input.delegate) {
      return ownerKey(PublicKeyCtor.fromBase58(input.delegate));
    }
  }

  return FieldCtor(0);
}

/** Requests Auro field signature and converts it into o1js Signature for circuit verification. */
async function signProposalHash(hashAsFieldString: string): Promise<any | null> {
  const signed = await getAuroSignFields([hashAsFieldString]);
  if (!signed?.signature) return null;

  try {
    return Signature.fromBase58(signed.signature);
  } catch {
    return null;
  }
}
