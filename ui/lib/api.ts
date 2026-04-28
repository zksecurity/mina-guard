import {
  type ApprovalRecord,
  type ContractSummary,
  type IndexerStatus,
  type OwnerRecord,
  type Proposal,
  type ProposalReceiver,
  normalizeDestination,
  normalizeTxType,
} from '@/lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

/** Fetches indexer status from backend monitoring endpoint. */
export async function fetchIndexerStatus(): Promise<IndexerStatus | null> {
  return getJson<IndexerStatus>('/api/indexer/status');
}

/** Fetches all discovered contracts from backend. */
export async function fetchContracts(): Promise<ContractSummary[]> {
  const data = await getJson<Array<Record<string, unknown>>>('/api/contracts');
  if (!data) return [];
  return data.map((item) => toContractSummary(item));
}

/** Fetches a single contract record by address. */
export async function fetchContract(address: string): Promise<ContractSummary | null> {
  const data = await getJson<Record<string, unknown>>(`/api/contracts/${address}`);
  return data ? toContractSummary(data) : null;
}

/** Lists direct subaccounts of a parent contract. */
export async function fetchChildren(parentAddress: string): Promise<ContractSummary[]> {
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${parentAddress}/children`,
  );
  if (!data) return [];
  return data.map((item) => toContractSummary(item));
}

/** Fetches owner list for the selected contract. */
export async function fetchOwners(address: string): Promise<OwnerRecord[]> {
  const data = await getJson<Array<Record<string, unknown>>>(`/api/contracts/${address}/owners`);
  if (!data) return [];
  return data.map((item) => ({
    address: asString(item.address) ?? '',
    ownerHash: asNullableString(item.ownerHash),
    index: asNullableNumber(item.index),
    active: asBoolean(item.active),
  }));
}

/** Fetches proposals for a contract with optional status filtering. */
export async function fetchProposals(
  address: string,
  options?: { status?: string; limit?: number; offset?: number }
): Promise<Proposal[]> {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));

  const qs = params.toString() ? `?${params.toString()}` : '';
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/proposals${qs}`
  );
  if (!data) return [];
  return data.map((item) => toProposal(item));
}

/** Fetches one proposal by proposalHash for detail pages. */
export async function fetchProposal(
  address: string,
  proposalHash: string
): Promise<Proposal | null> {
  const data = await getJson<Record<string, unknown>>(
    `/api/contracts/${address}/proposals/${proposalHash}`
  );
  return data ? toProposal(data) : null;
}

/** Fetches all approval rows for one proposal. */
export async function fetchApprovals(
  address: string,
  proposalHash: string
): Promise<ApprovalRecord[]> {
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/proposals/${proposalHash}/approvals`
  );
  if (!data) return [];
  return data.map((item) => ({
    approver: asString(item.approver) ?? '',
    approvalRaw: asNullableString(item.approvalRaw),
    blockHeight: asNullableNumber(item.blockHeight),
    createdAt: asString(item.createdAt) ?? new Date(0).toISOString(),
  }));
}

/** Fetches MINA token balance (in nanomina) for a wallet address. */
export async function fetchBalance(address: string): Promise<string | null> {
  const data = await getJson<{ balance: string }>(`/api/account/${address}/balance`);
  return data?.balance ?? null;
}

/** Pulls the tx hash out of the worker's success message. The worker uses a
 *  few different prefixes — "Transaction submitted", "Approval submitted",
 *  "Deploy submitted", "Subaccount action submitted" (CREATE_CHILD finalize
 *  + child lifecycle txs) — but the shape is always `<phrase> submitted: <hash>`. */
export function extractTxHash(message: string | null): string | null {
  if (!message) return null;
  const match = message.match(/(?:Transaction|Approval|Deploy|Subaccount action)\s+submitted:\s*(\S+)/);
  return match ? match[1] : null;
}

/** Looks up a submitted zkApp tx hash on the daemon's bestChain. Used by the
 *  reconciliation observer to detect failed/dropped CREATE submissions, which
 *  have no Proposal row to attach the failure to server-side. */
export async function fetchTxStatus(
  txHash: string,
): Promise<{ status: 'pending' | 'included' | 'failed'; reason?: string } | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/tx-status?hash=${encodeURIComponent(txHash)}`,
      { cache: 'no-store' },
    );
    if (!response.ok) return null;
    return (await response.json()) as { status: 'pending' | 'included' | 'failed'; reason?: string };
  } catch (err) {
    console.warn('[api] fetchTxStatus failed', err);
    return null;
  }
}

/** Best-effort: tells the backend about a freshly-submitted approve/execute tx
 *  so its indexer can poll for on-chain failure and surface the reason. */
export async function recordSubmission(
  contractAddress: string,
  proposalHash: string,
  action: 'approve' | 'execute',
  txHash: string,
): Promise<void> {
  try {
    await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/proposals/${proposalHash}/submissions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, txHash }),
      },
    );
  } catch (err) {
    console.warn('[api] recordSubmission failed', err);
  }
}

/** Generic JSON fetch helper with null-on-error semantics for resilient polling. */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
    if (!response.ok) {
      console.error(`[api] getJson(${path}) returned ${response.status}:`, await response.text());
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    console.error(`[api] getJson(${path}) failed:`, err);
    return null;
  }
}

/** Normalizes backend contract rows into strict typed frontend summary objects. */
function toContractSummary(input: Record<string, unknown>): ContractSummary {
  return {
    address: asString(input.address) ?? '',
    networkId: asNullableString(input.networkId),
    ownersCommitment: asNullableString(input.ownersCommitment),
    threshold: asNullableNumber(input.threshold),
    numOwners: asNullableNumber(input.numOwners),
    nonce: asNullableNumber(input.nonce) ?? asNullableNumber(input.proposalCounter),
    configNonce: asNullableNumber(input.configNonce),
    parent: asNullableString(input.parent),
    parentNonce: asNullableNumber(input.parentNonce),
    childMultiSigEnabled: asNullableBoolean(input.childMultiSigEnabled),
    delegate: asNullableString(input.delegate),
    discoveredAt: asString(input.discoveredAt) ?? new Date(0).toISOString(),
    lastSyncedAt: asNullableString(input.lastSyncedAt),
  };
}

/** Normalizes backend proposal rows and txType encodings for UI components. */
function toProposal(input: Record<string, unknown>): Proposal {
  const receivers = asReceivers(input.receivers);
  const totalAmount = asNullableString(input.totalAmount)
    ?? (receivers.length > 0
      ? receivers.reduce((sum, receiver) => sum + BigInt(receiver.amount), 0n).toString()
      : null);
  return {
    proposalHash: asString(input.proposalHash) ?? '',
    proposer: asNullableString(input.proposer),
    toAddress: asNullableString(input.toAddress),
    tokenId: asNullableString(input.tokenId),
    txType: normalizeTxType(asNullableString(input.txType)),
    data: asNullableString(input.data),
    nonce: asNullableString(input.nonce) ?? asNullableString(input.uid),
    configNonce: asNullableString(input.configNonce),
    expiryBlock: asNullableString(input.expiryBlock),
    networkId: asNullableString(input.networkId),
    guardAddress: asNullableString(input.guardAddress),
    memo: asNullableString(input.memo),
    memoHash: asNullableString(input.memoHash),
    proposalMemoMatch: asMemoMatch(input.proposalMemoMatch),
    memoExecutionMatch: asMemoMatch(input.memoExecutionMatch),
    destination: normalizeDestination(asNullableString(input.destination)),
    childAccount: asNullableString(input.childAccount),
    status: asProposalStatus(input.status),
    invalidReason: asNullableString(input.invalidReason),
    approvalCount: asNumber(input.approvalCount),
    createdAtBlock: asNullableNumber(input.createdAtBlock),
    executedAtBlock: asNullableNumber(input.executedAtBlock),
    lastApproveTxHash: asNullableString(input.lastApproveTxHash),
    lastExecuteTxHash: asNullableString(input.lastExecuteTxHash),
    lastApproveError: asNullableString(input.lastApproveError),
    lastExecuteError: asNullableString(input.lastExecuteError),
    createdAt: asString(input.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(input.updatedAt) ?? new Date(0).toISOString(),
    receivers,
    recipientCount: asNullableNumber(input.recipientCount) ?? receivers.length,
    totalAmount,
  };
}

/** Converts unknown values to string while preserving nullability. */
function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/** Converts unknown values to strict number with zero fallback for counters. */
function asNumber(value: unknown): number {
  const raw = asNullableNumber(value);
  return raw ?? 0;
}

/** Converts unknown values to nullable number for optional numeric fields. */
function asNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Converts unknown values to strict booleans. */
function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  if (typeof value === 'number') return value === 1;
  return false;
}

/** Converts unknown values to nullable boolean; distinguishes unset vs false. */
function asNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return null;
  }
  if (typeof value === 'number') return value === 1;
  return null;
}

/** Converts unknown values to nullable strings for optional columns. */
function asNullableString(value: unknown): string | null {
  const stringValue = asString(value);
  return stringValue ?? null;
}

/** Converts status text to one of the allowed proposal status values. */
function asProposalStatus(value: unknown): Proposal['status'] {
  const text = asString(value);
  if (text === 'executed' || text === 'expired' || text === 'invalidated') return text;
  return 'pending';
}

function asMemoMatch(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function asReceivers(value: unknown): ProposalReceiver[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    return {
      index: asNullableNumber(record.index) ?? index,
      address: asString(record.address) ?? '',
      amount: asString(record.amount) ?? '0',
    };
  });
}

/** Fetches all raw indexed events for a contract using paginated backend API reads. */
export async function fetchAllEvents(contractAddress: string): Promise<Array<{ eventType: string; payload: unknown }>> {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const response = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/events?limit=${limit}&offset=${offset}`,
      { cache: 'no-store' }
    );

    if (!response.ok) {
      console.error(`[api] fetchAllEvents page at offset=${offset} returned ${response.status}`);
      break;
    }

    const batch = (await response.json()) as Array<{ eventType: string; payload: unknown }>;
    events.push(
      ...batch.map((event) => ({
        eventType: event.eventType,
        payload:
          typeof event.payload === 'string'
            ? safeParseJson(event.payload)
            : event.payload,
      }))
    );

    if (batch.length < limit) break;
    offset += limit;
  }

  return events.reverse();
}

/** Parses JSON strings defensively when backend stores raw payload text. */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
