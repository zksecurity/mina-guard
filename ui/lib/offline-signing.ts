import { parseChildConfigFromEvents, fetchAllEvents } from './api';
import { computeCreateChildConfigHash, exportStoreCheckpoint } from './multisigClient';
import type { StoreCheckpoint } from 'contracts';
import { OFFLINE_RESPONSE_VERSION } from './offline-format';
import { getMinaGuardConfig } from './endpoints';

/** Version 2 adds the SubVault owners and threshold to CREATE_CHILD approve bundles. */
export const OFFLINE_BUNDLE_VERSION = 2;

interface BundleReceiver {
  address: string;
  amount: string;
}

export interface BundleAccount {
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

interface BundleBase {
  version: typeof OFFLINE_BUNDLE_VERSION;
  storeCheckpoint: StoreCheckpoint;
  minaNetwork: 'testnet' | 'mainnet';
  contractAddress: string;
  feePayerAddress: string;
  accounts: Record<string, BundleAccount>;
  events: Array<{ eventType: string; payload: unknown; blockHeight?: number | null }>;
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
    memo?: string;
    childPrivateKey?: string;
    childOwners?: string[];
    childThreshold?: number;
  };
  configNonce: number;
}

export interface OfflineApproveBundle extends BundleBase {
  action: 'approve';
  proposal: {
    proposalHash: string;
    proposer: string | null;
    toAddress: string | null;
    tokenId: string | null;
    txType: string | null;
    data: string | null;
    nonce: string | null;
    configNonce: string | null;
    expirySlot: string | null;
    guardAddress: string | null;
    destination: string | null;
    childAccount: string | null;
    memoHash: string | null;
    receivers: BundleReceiver[];
    [key: string]: unknown;
  };
  /** CREATE_CHILD only: the reserved SubVault configuration, checked against
   *  `proposal.data` before export, for the CLI to check and show again. */
  childAddress?: string;
  childOwners?: string[];
  childThreshold?: number;
}

export interface OfflineExecuteBundle extends BundleBase {
  action: 'execute';
  proposal: OfflineApproveBundle['proposal'];
  receiverAccountExists: Record<string, boolean>;
  childAddress?: string;
  childEvents?: Array<{ eventType: string; payload: unknown; blockHeight?: number | null }>;
  childOwners?: string[];
  childThreshold?: number;
}

export type OfflineRequestBundle =
  | OfflineProposeBundle
  | OfflineApproveBundle
  | OfflineExecuteBundle;

export interface OfflineSignedTxResponse {
  version: typeof OFFLINE_RESPONSE_VERSION;
  type: 'offline-signed-tx';
  action: 'propose' | 'approve' | 'execute';
  contractAddress: string;
  proposalHash: string;
  transaction: unknown;
}

const MINA_ADDRESS_RE = /^B62q[1-9A-HJ-NP-Za-km-z]{51}$/;

export function assertValidMinaAddress(address: string): void {
  if (!MINA_ADDRESS_RE.test(address)) {
    throw new Error('Enter a valid Mina address (starts with B62q, 55 characters)');
  }
}

// ---------------------------------------------------------------------------
// Bundle builders — heavy checkpoint work is delegated to the shared worker
// ---------------------------------------------------------------------------

/** Resolved lazily (not at module scope) so the desktop shell's runtime
 *  window.__minaGuardConfig override applies, matching the worker path. */
function minaEndpoint(): string {
  return getMinaGuardConfig().minaEndpoint;
}

/** Bundle network id — selects the CLI's fee-payer signature domain.
 *  Bundles use mainnet/testnet; devnet shares the testnet signature and
 *  proposal domains. Map only known labels, never unknown networks. */
function minaNetwork(): 'testnet' | 'mainnet' {
  const network = getMinaGuardConfig().networkId;
  if (network === 'mainnet') return 'mainnet';
  if (network === 'testnet' || network === 'devnet') return 'testnet';
  throw new Error(`Unsupported offline signing network: ${network}`);
}

async function fetchGraphQLAccount(address: string): Promise<BundleAccount> {
  const query = `query($publicKey: PublicKey!) {
    account(publicKey: $publicKey) {
      publicKey
      token
      nonce
      balance { total }
      tokenSymbol
      receiptChainHash
      timing { initialMinimumBalance cliffTime cliffAmount vestingPeriod vestingIncrement }
      permissions { editState send receive setDelegate setPermissions setVerificationKey setZkappUri editActionState setTokenSymbol incrementNonce setVotingFor setTiming }
      delegateAccount { publicKey }
      votingFor
      zkappState
      verificationKey { verificationKey hash }
      actionState
      provedState
      zkappUri
    }
  }`;
  const res = await fetch(minaEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { publicKey: address } }),
  });
  const json = await res.json();
  // A node error is not "no such account": guessing would make the CLI fund
  // an account that exists, or skip funding one that does not.
  if (!res.ok || json.errors || !json.data) {
    throw new Error(`Could not fetch account ${address} from the Mina node`);
  }
  const account = json.data.account ?? null;
  // The CLI decides from the snapshot's fields; an answer without them is no snapshot.
  if (account !== null && !['nonce', 'balance', 'zkappState'].every((field) => typeof account === 'object' && field in account)) {
    throw new Error(`Incomplete account snapshot for ${address} from the Mina node`);
  }
  return account;
}

async function checkAccountExists(address: string): Promise<boolean> {
  const account = await fetchGraphQLAccount(address);
  return !!account;
}

export async function buildOfflineProposeBundle(params: {
  contractAddress: string;
  feePayerAddress: string;
  input: OfflineProposeBundle['input'];
  configNonce: number;
}): Promise<OfflineProposeBundle> {
  const network = minaNetwork();
  const storeCheckpoint = await exportStoreCheckpoint(params.contractAddress);
  const fetches: Promise<BundleAccount>[] = [
    fetchGraphQLAccount(params.contractAddress),
    fetchGraphQLAccount(params.feePayerAddress),
  ];
  if (params.input.childAccount) {
    fetches.push(fetchGraphQLAccount(params.input.childAccount));
  }
  const [contractAccount, feePayerAccount, childAccount] = await Promise.all(fetches);

  const accounts: Record<string, BundleAccount> = {
    [params.contractAddress]: contractAccount,
    [params.feePayerAddress]: feePayerAccount,
  };
  if (params.input.childAccount && childAccount) {
    accounts[params.input.childAccount] = childAccount;
  }

  return {
    version: OFFLINE_BUNDLE_VERSION,
    action: 'propose',
    minaNetwork: network,
    contractAddress: params.contractAddress,
    feePayerAddress: params.feePayerAddress,
    accounts,
    events: [],
    storeCheckpoint,
    input: params.input,
    configNonce: params.configNonce,
  };
}

/**
 * Fetches the SubVault's reserved owners and threshold from its own events and
 * checks that they hash to the parent-approved proposal data. Throws when the
 * reservation is not indexed yet or does not match: an approver must see the
 * configuration the proposal commits to, or not sign.
 */
async function fetchVerifiedChildConfig(childAddress: string, proposalData: string | null) {
  const events = await fetchAllEvents(childAddress);
  const config = parseChildConfigFromEvents(events, childAddress);
  if (!config) {
    throw new Error(
      'SubVault config events not found for this proposal. ' +
      'The createChildConfig events may not have been indexed yet — try again shortly.',
    );
  }
  const { configHash } = await computeCreateChildConfigHash({
    childOwners: config.owners,
    childThreshold: config.threshold,
    // The reserved slot order is what the signed data binds.
    preserveOrder: true,
  });
  if (configHash !== proposalData) {
    throw new Error('SubVault reservation does not match the parent-approved proposal data');
  }
  return { events, owners: config.owners, threshold: config.threshold };
}

export async function buildOfflineApproveBundle(params: {
  contractAddress: string;
  feePayerAddress: string;
  proposal: OfflineApproveBundle['proposal'];
}): Promise<OfflineApproveBundle> {
  const network = minaNetwork();
  const storeCheckpoint = await exportStoreCheckpoint(params.contractAddress);
  const fetches: Promise<BundleAccount>[] = [
    fetchGraphQLAccount(params.contractAddress),
    fetchGraphQLAccount(params.feePayerAddress),
  ];
  const childAddr = params.proposal.childAccount;
  if (childAddr) fetches.push(fetchGraphQLAccount(childAddr));
  const [contractAccount, feePayerAccount, childAccount] = await Promise.all(fetches);

  const accounts: Record<string, BundleAccount> = {
    [params.contractAddress]: contractAccount,
    [params.feePayerAddress]: feePayerAccount,
  };
  if (childAddr && childAccount) accounts[childAddr] = childAccount;

  // A CREATE_CHILD approval authorizes the SubVault's owners and threshold, so
  // the bundle carries them for the CLI to check and show before signing.
  const childConfig = params.proposal.txType === 'createChild' && childAddr
    ? { childAddress: childAddr, ...(await fetchVerifiedChildConfig(childAddr, params.proposal.data)) }
    : null;

  return {
    version: OFFLINE_BUNDLE_VERSION,
    action: 'approve',
    minaNetwork: network,
    contractAddress: params.contractAddress,
    feePayerAddress: params.feePayerAddress,
    accounts,
    events: [],
    storeCheckpoint,
    proposal: params.proposal,
    ...(childConfig
      ? { childAddress: childConfig.childAddress, childOwners: childConfig.owners, childThreshold: childConfig.threshold }
      : {}),
  };
}

export async function buildOfflineExecuteBundle(params: {
  contractAddress: string;
  feePayerAddress: string;
  proposal: OfflineApproveBundle['proposal'];
  childAddress?: string;
  childEvents?: Array<{ eventType: string; payload: unknown; blockHeight?: number | null }>;
}): Promise<OfflineExecuteBundle> {
  const network = minaNetwork();
  const storeCheckpoint = await exportStoreCheckpoint(params.contractAddress);
  const fetches: Promise<BundleAccount>[] = [
    fetchGraphQLAccount(params.contractAddress),
    fetchGraphQLAccount(params.feePayerAddress),
  ];
  const childAddr = params.proposal.childAccount;
  if (childAddr) fetches.push(fetchGraphQLAccount(childAddr));
  const [contractAccount, feePayerAccount, childAccount] = await Promise.all(fetches);

  const accounts: Record<string, BundleAccount> = {
    [params.contractAddress]: contractAccount,
    [params.feePayerAddress]: feePayerAccount,
  };
  if (childAddr && childAccount) accounts[childAddr] = childAccount;

  const receiverAccountExists: Record<string, boolean> = {};
  const emptyKey = 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG';
  await Promise.all(
    params.proposal.receivers
      .filter((r) => r.address && r.address !== emptyKey)
      .map(async (r) => {
        if (params.proposal.txType === 'allocateChild') {
          // Allocation proves recipient initialization and parent binding.
          // The air-gapped CLI needs the complete account, not just existence.
          accounts[r.address] = await fetchGraphQLAccount(r.address);
          receiverAccountExists[r.address] = true;
        } else {
          receiverAccountExists[r.address] = await checkAccountExists(r.address);
        }
      }),
  );

  let childAddress = params.childAddress;
  let childEvents = params.childEvents;
  let childOwners: string[] | undefined;
  let childThreshold: number | undefined;

  const isCreateChild = params.proposal.txType === 'createChild';
  const isChildLifecycle = params.proposal.txType === 'reclaimChild' ||
    params.proposal.txType === 'destroyChild' ||
    params.proposal.txType === 'enableChildMultiSig';

  if (isChildLifecycle && childAddr && !childEvents) {
    childAddress = childAddr;
    childEvents = await fetchAllEvents(childAddress);
  }

  if (isCreateChild && childAddr) {
    childAddress = childAddr;
    const config = await fetchVerifiedChildConfig(childAddr, params.proposal.data);
    childEvents = config.events;
    childOwners = config.owners;
    childThreshold = config.threshold;
  }

  return {
    version: OFFLINE_BUNDLE_VERSION,
    action: 'execute',
    minaNetwork: network,
    contractAddress: params.contractAddress,
    feePayerAddress: params.feePayerAddress,
    accounts,
    events: [],
    storeCheckpoint,
    proposal: params.proposal,
    receiverAccountExists,
    childAddress,
    childEvents,
    childOwners,
    childThreshold,
  };
}
