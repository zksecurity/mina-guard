export const OFFLINE_BUNDLE_VERSION = 1;

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
    expiryBlock?: number;
    memo?: string;
  };
  configNonce: number;
  networkId: string;
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
    expiryBlock: string | null;
    networkId: string | null;
    guardAddress: string | null;
    destination: string | null;
    childAccount: string | null;
    memoHash: string | null;
    receivers: BundleReceiver[];
    [key: string]: unknown;
  };
}

export interface OfflineExecuteBundle extends BundleBase {
  action: 'execute';
  proposal: OfflineApproveBundle['proposal'];
  receiverAccountExists: Record<string, boolean>;
  childAddress?: string;
  childEvents?: Array<{ eventType: string; payload: unknown }>;
}

export type OfflineRequestBundle =
  | OfflineProposeBundle
  | OfflineApproveBundle
  | OfflineExecuteBundle;

export interface OfflineSignedTxResponse {
  version: 1;
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
// Bundle builders — run on main thread, no o1js needed
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'http://127.0.0.1:8080/graphql';
const MINA_NETWORK = (process.env.NEXT_PUBLIC_MINA_NETWORK as 'testnet' | 'mainnet') || 'testnet';

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
  const res = await fetch(MINA_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { publicKey: address } }),
  });
  const json = await res.json();
  return json.data?.account ?? null;
}

async function fetchAllEvents(contractAddress: string): Promise<Array<{ eventType: string; payload: unknown }>> {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const res = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/events?limit=${limit}&offset=${offset}`,
      { cache: 'no-store' },
    );
    if (!res.ok) break;
    const batch = await res.json();
    events.push(...batch.map((e: any) => ({
      eventType: e.eventType,
      payload: typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload,
    })));
    if (batch.length < limit) break;
    offset += limit;
  }
  return events.reverse();
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
  networkId: string;
}): Promise<OfflineProposeBundle> {
  const fetches: Promise<BundleAccount>[] = [
    fetchGraphQLAccount(params.contractAddress),
    fetchGraphQLAccount(params.feePayerAddress),
  ];
  if (params.input.childAccount) {
    fetches.push(fetchGraphQLAccount(params.input.childAccount));
  }
  const [contractAccount, feePayerAccount, childAccount] = await Promise.all(fetches);
  const events = await fetchAllEvents(params.contractAddress);

  const accounts: Record<string, BundleAccount> = {
    [params.contractAddress]: contractAccount,
    [params.feePayerAddress]: feePayerAccount,
  };
  if (params.input.childAccount && childAccount) {
    accounts[params.input.childAccount] = childAccount;
  }

  return {
    version: 1,
    action: 'propose',
    minaNetwork: MINA_NETWORK,
    contractAddress: params.contractAddress,
    feePayerAddress: params.feePayerAddress,
    accounts,
    events,
    input: params.input,
    configNonce: params.configNonce,
    networkId: params.networkId,
  };
}

export async function buildOfflineApproveBundle(params: {
  contractAddress: string;
  feePayerAddress: string;
  proposal: OfflineApproveBundle['proposal'];
}): Promise<OfflineApproveBundle> {
  const fetches: Promise<BundleAccount>[] = [
    fetchGraphQLAccount(params.contractAddress),
    fetchGraphQLAccount(params.feePayerAddress),
  ];
  const childAddr = params.proposal.childAccount;
  if (childAddr) fetches.push(fetchGraphQLAccount(childAddr));
  const [contractAccount, feePayerAccount, childAccount] = await Promise.all(fetches);
  const events = await fetchAllEvents(params.contractAddress);

  const accounts: Record<string, BundleAccount> = {
    [params.contractAddress]: contractAccount,
    [params.feePayerAddress]: feePayerAccount,
  };
  if (childAddr && childAccount) accounts[childAddr] = childAccount;

  return {
    version: 1,
    action: 'approve',
    minaNetwork: MINA_NETWORK,
    contractAddress: params.contractAddress,
    feePayerAddress: params.feePayerAddress,
    accounts,
    events,
    proposal: params.proposal,
  };
}

export async function buildOfflineExecuteBundle(params: {
  contractAddress: string;
  feePayerAddress: string;
  proposal: OfflineApproveBundle['proposal'];
  childAddress?: string;
  childEvents?: Array<{ eventType: string; payload: unknown }>;
}): Promise<OfflineExecuteBundle> {
  const fetches: Promise<BundleAccount>[] = [
    fetchGraphQLAccount(params.contractAddress),
    fetchGraphQLAccount(params.feePayerAddress),
  ];
  const childAddr = params.proposal.childAccount;
  if (childAddr) fetches.push(fetchGraphQLAccount(childAddr));
  const [contractAccount, feePayerAccount, childAccount] = await Promise.all(fetches);
  const events = await fetchAllEvents(params.contractAddress);

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
        receiverAccountExists[r.address] = await checkAccountExists(r.address);
      }),
  );

  let childAddress = params.childAddress;
  let childEvents = params.childEvents;
  const isChildLifecycle = params.proposal.txType === 'reclaimChild' ||
    params.proposal.txType === 'destroyChild' ||
    params.proposal.txType === 'enableChildMultiSig';
  if (isChildLifecycle && childAddr && !childEvents) {
    childAddress = childAddr;
    childEvents = await fetchAllEvents(childAddress);
  }

  return {
    version: 1,
    action: 'execute',
    minaNetwork: MINA_NETWORK,
    contractAddress: params.contractAddress,
    feePayerAddress: params.feePayerAddress,
    accounts,
    events,
    proposal: params.proposal,
    receiverAccountExists,
    childAddress,
    childEvents,
  };
}
