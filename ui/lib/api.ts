import {
  type ApprovalRecord,
  type ContractSummary,
  type IndexerStatus,
  type OwnerRecord,
  type Proposal,
  type ProposalReceiver,
  normalizeDestination,
  normalizeTxType,
  sumReceiverAmounts,
} from '@/lib/types';
import { getMinaGuardConfig } from '@/lib/endpoints';
import { MAX_RECEIVERS } from '@/lib/constants';
import { markPendingTxRecorded, markPendingTxUntracked } from '@/lib/storage';
import {
  GUARD_PERMISSION_KINDS,
  GUARD_PERMISSION_NAMES,
  GUARD_SET_VERIFICATION_KEY_TXN_VERSION,
  type GuardPermissionName,
} from 'contracts/guard-permission-policy';

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

export interface VaultSecurityStatus {
  accountFound: boolean;
  verificationKeyHash: string | null;
  setVerificationKeyTxnVersion: string | null;
  verificationKeyMatches: boolean;
  permissionKinds: Partial<Record<PermissionFieldName, string>>;
  expectedPermissionKinds: Partial<Record<PermissionFieldName, string>>;
  permissionMismatches: string[];
  safe: boolean;
}

type PermissionFieldName = GuardPermissionName;

/**
 * Browser-side trust anchor. Keep this serialized form in lockstep with the
 * o1js GUARD_PERMISSIONS constant; unlike API-supplied expected values, it
 * cannot be changed by a compromised indexer response.
 */
const EXPECTED_PERMISSION_KINDS: Record<PermissionFieldName, string> =
  GUARD_PERMISSION_KINDS;
const PERMISSION_FIELD_NAMES = GUARD_PERMISSION_NAMES;

/**
 * Fetches and validates the account directly from the configured Mina node.
 * The browser does not trust the indexer to report either the actual or the
 * expected permission vector. The deterministic UI harness is the sole
 * exception because it intentionally runs without a chain.
 */
export async function fetchVaultSecurityStatus(
  address: string
): Promise<VaultSecurityStatus | null> {
  if (process.env.NEXT_PUBLIC_E2E_TEST === 'true') {
    return getJson<VaultSecurityStatus>(`/api/accounts/${address}/security`);
  }

  const query = `query($publicKey: PublicKey!) {
    account(publicKey: $publicKey) {
      verificationKey { hash }
      permissions {
        editState
        send
        receive
        setDelegate
        setPermissions
        setVerificationKey { auth txnVersion }
        setZkappUri
        editActionState
        setTokenSymbol
        incrementNonce
        setVotingFor
        setTiming
        access
      }
    }
  }`;

  try {
    const response = await fetch(getMinaGuardConfig().minaEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ query, variables: { publicKey: address } }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: {
        account?: {
          verificationKey?: { hash?: string | null } | null;
          permissions?: Record<string, unknown> | null;
        } | null;
      };
      errors?: unknown;
    };
    if (body.errors) return null;
    const account = body.data?.account;
    if (!account) {
      return {
        accountFound: false,
        verificationKeyHash: null,
        setVerificationKeyTxnVersion: null,
        verificationKeyMatches: false,
        permissionKinds: {},
        expectedPermissionKinds: EXPECTED_PERMISSION_KINDS,
        permissionMismatches: [...PERMISSION_FIELD_NAMES],
        safe: false,
      };
    }

    const raw = account.permissions ?? {};
    const setVerificationKey = raw.setVerificationKey as
      | {
          auth?: unknown;
          txnVersion?: unknown;
        }
      | undefined;
    const permissionKinds: Partial<Record<PermissionFieldName, string>> = {};
    for (const name of PERMISSION_FIELD_NAMES) {
      const value =
        name === 'setVerificationKey' ? setVerificationKey?.auth : raw[name];
      if (typeof value === 'string') permissionKinds[name] = value;
    }
    const permissionMismatches = PERMISSION_FIELD_NAMES.filter(
      (name) => permissionKinds[name] !== EXPECTED_PERMISSION_KINDS[name]
    );
    if (
      String(setVerificationKey?.txnVersion ?? '') !==
        GUARD_SET_VERIFICATION_KEY_TXN_VERSION &&
      !permissionMismatches.includes('setVerificationKey')
    ) {
      permissionMismatches.push('setVerificationKey');
    }

    const verificationKeyHash = account.verificationKey?.hash ?? null;
    const expectedVkHash =
      process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH?.trim() || null;
    const verificationKeyMatches =
      verificationKeyHash !== null &&
      expectedVkHash !== null &&
      verificationKeyHash === expectedVkHash;
    const setVerificationKeyTxnVersion = setVerificationKey?.txnVersion == null
      ? null : String(setVerificationKey.txnVersion);
    // The same reviewed VK can still prove an ordinary action after a version
    // upgrade. A successful proved account update refreshes the stored version;
    // the deploy-key fallback remains visible in permissionMismatches meanwhile.
    const matchingOlderVersion = verificationKeyMatches &&
      permissionKinds.setVerificationKey === EXPECTED_PERMISSION_KINDS.setVerificationKey &&
      permissionMismatches.length === 1 && permissionMismatches[0] === 'setVerificationKey' &&
      setVerificationKeyTxnVersion !== null &&
      /^(0|[1-9][0-9]*)$/.test(setVerificationKeyTxnVersion) &&
      BigInt(setVerificationKeyTxnVersion) < BigInt(GUARD_SET_VERIFICATION_KEY_TXN_VERSION);
    return {
      accountFound: true,
      verificationKeyHash,
      setVerificationKeyTxnVersion,
      verificationKeyMatches,
      permissionKinds,
      expectedPermissionKinds: EXPECTED_PERMISSION_KINDS,
      permissionMismatches,
      safe: verificationKeyMatches && (permissionMismatches.length === 0 || matchingOlderVersion),
    };
  } catch {
    return null;
  }
}

/** UI-side, field-by-field permission check. Fails closed on missing fields. */
export function isCanonicalVaultSecurity(
  status: VaultSecurityStatus | null
): boolean {
  return (
    status !== null &&
    status.accountFound &&
    status.verificationKeyMatches &&
    status.safe &&
    PERMISSION_FIELD_NAMES.every(
      (name) => status.permissionKinds[name] === EXPECTED_PERMISSION_KINDS[name]
    )
  );
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

export type SubscribeResult =
  | { ok: true }
  | { ok: false; status: number | null; error: string | null };

/** Subscribes the lite-mode indexer to a contract address. Idempotent server-side. */
export async function subscribeAddress(
  address: string,
  fromBlock?: number,
): Promise<SubscribeResult> {
  try {
    const response = await fetch(`${API_BASE}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(
        fromBlock === undefined ? { address } : { address, fromBlock },
      ),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[api] subscribeAddress(${address}) returned ${response.status}:`, text);
      let error: string | null = null;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') error = parsed.error;
      } catch {
        // non-JSON body; leave error as null
      }
      return { ok: false, status: response.status, error };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[api] subscribeAddress(${address}) failed:`, err);
    return { ok: false, status: null, error: null };
  }
}

/** Pulls the tx hash out of the worker's success message. The worker uses a
 *  few different prefixes — "Transaction submitted", "Approval submitted",
 *  "Deploy submitted", "SubVault setup submitted" (CREATE_CHILD execute),
 *  "SubVault action submitted" (child lifecycle txs) — but the shape is
 *  always `<phrase> submitted: <hash>`. */
export function extractTxHash(message: string | null): string | null {
  if (!message) return null;
  const match = message.match(/(?:Transaction|Approval|Deploy|SubVault (?:action|setup))\s+submitted:\s*(\S+)/);
  return match ? match[1] : null;
}

/** Looks up a submitted zkApp tx hash on the daemon's bestChain. Used by the
 *  reconciliation observer to detect failed/dropped CREATE submissions, which
 *  have no Proposal row to attach the failure to server-side. */
export async function fetchTxStatus(
  txHash: string,
): Promise<{ status: 'pending' | 'included' | 'failed' | 'unknown'; reason?: string } | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/tx-status?hash=${encodeURIComponent(txHash)}`,
      { cache: 'no-store' },
    );
    if (!response.ok) return null;
    return (await response.json()) as { status: 'pending' | 'included' | 'failed' | 'unknown'; reason?: string };
  } catch (err) {
    console.warn('[api] fetchTxStatus failed', err);
    return null;
  }
}

/** Best-effort: tells the backend about a freshly-submitted approve/execute tx
 *  so its indexer can poll for on-chain failure and surface the reason, and
 *  other owners' screens can wait for it. The backend records the hash only
 *  after its Mina node shows it is that action on this proposal. Returns
 *  whether the backend recorded it. */
export async function recordSubmission(
  contractAddress: string,
  proposalHash: string,
  action: 'approve' | 'execute',
  txHash: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/proposals/${proposalHash}/submissions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, txHash }),
      },
    );
    return res.ok;
  } catch (err) {
    console.warn('[api] recordSubmission failed', err);
    return false;
  }
}

/** Reports a broadcast approve/execute without waiting: the backend's check can
 *  take seconds, and this tab already locks from its own pending record. An
 *  accepted report marks the record `recorded`, so later polls can tell when
 *  the backend stops tracking it. If the backend refuses, it will never report
 *  the transaction's failure, so the record is marked to expire sooner. Call
 *  after savePendingTx. */
export function reportSubmission(
  contractAddress: string,
  proposalHash: string,
  action: 'approve' | 'execute',
  txHash: string,
): void {
  void recordSubmission(contractAddress, proposalHash, action, txHash).then((recorded) => {
    if (recorded) markPendingTxRecorded(contractAddress, proposalHash, action, txHash);
    else markPendingTxUntracked(contractAddress, proposalHash, action, txHash);
  });
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
    permissionsVerified: input.permissionsVerified === true,
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

/**
 * Normalizes backend proposal rows and txType encodings for UI components.
 * The total, recipient count and governance target are worked out here from
 * the receivers the proposal hash commits to. The server's precomputed copies
 * of those values are ignored, so a wrong server cannot change what an owner
 * sees next to Approve.
 */
export function toProposal(input: Record<string, unknown>): Proposal {
  // A proposal has MAX_RECEIVERS slots and the worker signs only those, so
  // rows beyond them are dropped here; every list, total and export matches.
  const receivers = asReceivers(input.receivers).slice(0, MAX_RECEIVERS);
  const totalAmount = receivers.length > 0 ? sumReceiverAmounts(receivers).toString() : null;
  return {
    proposalHash: asString(input.proposalHash) ?? '',
    proposer: asNullableString(input.proposer),
    // Owner to add or remove, or the delegate: receivers[0] in the signed proposal.
    toAddress: receivers[0]?.address ?? null,
    tokenId: asNullableString(input.tokenId),
    txType: normalizeTxType(asNullableString(input.txType)),
    data: asNullableString(input.data),
    nonce: asNullableString(input.nonce) ?? asNullableString(input.uid),
    configNonce: asNullableString(input.configNonce),
    expirySlot: asNullableString(input.expirySlot),
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
    executionTxHash: asNullableString(input.executionTxHash),
    lastApproveTxHash: asNullableString(input.lastApproveTxHash),
    lastExecuteTxHash: asNullableString(input.lastExecuteTxHash),
    lastApproveError: asNullableString(input.lastApproveError),
    lastExecuteError: asNullableString(input.lastExecuteError),
    createdAt: asString(input.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(input.updatedAt) ?? new Date(0).toISOString(),
    receivers,
    recipientCount: receivers.length,
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
export async function fetchAllEvents(
  contractAddress: string,
  fromBlock?: number,
): Promise<Array<{ eventType: string; payload: unknown; blockHeight: number | null }>> {
  const events: Array<{ eventType: string; payload: unknown; blockHeight: number | null }> = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    // Fail closed before the backend would clamp and repeat offset 50,000.
    // Stable cursor pagination is tracked separately in issue #143.
    if (offset > 50_000) throw new Error('Event history exceeds the backend pagination limit');
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (fromBlock !== undefined) query.set('fromBlock', String(fromBlock));
    const response = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/events?${query}`,
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(`Could not fetch vault events (${response.status}); retry shortly.`);
    }

    const batch = (await response.json()) as Array<{ eventType: string; payload: unknown; blockHeight?: unknown }>;
    if (!Array.isArray(batch)) throw new Error('Invalid vault events response');
    events.push(
      ...batch.map((event) => ({
        eventType: event.eventType,
        payload:
          typeof event.payload === 'string'
            ? safeParseJson(event.payload)
            : event.payload,
        // lets the shared rebuild locate a divergence by block
        blockHeight: typeof event.blockHeight === 'number' ? event.blockHeight : null,
      }))
    );

    if (batch.length < limit) break;
    offset += limit;
  }

  return events.reverse();
}

/**
 * Parses reservation events fetched from one child vault. The proposalHash
 * emitted at reservation is a caller-supplied label, not an approval proof.
 * Pure function — used by both the online UI (api.ts) and offline bundle builder.
 */
export function parseChildConfigFromEvents(
  events: ReadonlyArray<{ eventType: string; payload: unknown }>,
  childAddress: string,
): { owners: string[]; threshold: number } | null {
  const EMPTY_KEY = 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG';

  const configEvents = events.filter((e) => e.eventType === 'createChildConfig');
  if (configEvents.length > 1) throw new Error('Multiple SubVault reservations found');
  const configEvent = configEvents[0];
  if (!configEvent) return null;
  const configPayload = configEvent.payload as Record<string, unknown>;
  if (configPayload?.childAccount !== childAddress) {
    throw new Error('SubVault reservation address mismatch');
  }
  const threshold = Number(configPayload.threshold ?? '0');
  const numOwners = Number(configPayload.numOwners ?? '0');
  if (!Number.isInteger(numOwners) || numOwners < 1 ||
      !Number.isInteger(threshold) || threshold < 1 || threshold > numOwners) {
    throw new Error('Invalid SubVault reservation governance');
  }

  const ownerEvents = events
    .filter((e) => e.eventType === 'createChildOwner')
    .sort((a, b) => {
      const ai = Number((a.payload as Record<string, unknown>)?.index ?? '0');
      const bi = Number((b.payload as Record<string, unknown>)?.index ?? '0');
      return ai - bi;
    });

  const owners: string[] = [];
  for (let index = 0; index < numOwners; index++) {
    const matches = ownerEvents.filter((e) =>
      Number((e.payload as Record<string, unknown>)?.index) === index);
    if (matches.length !== 1) throw new Error(`SubVault owner slot ${index} is missing or duplicated`);
    const owner = (matches[0].payload as Record<string, unknown>)?.owner;
    if (typeof owner !== 'string' || owner.length <= 10 || owner === EMPTY_KEY) {
      throw new Error(`Invalid SubVault owner at slot ${index}`);
    }
    owners.push(owner);
  }
  return { owners, threshold };
}

/**
 * Fetches the one reservation for a child. Callers must compare its computed
 * config hash with the parent-approved CREATE_CHILD proposal's data.
 */
export async function fetchChildConfigFromEvents(
  childAddress: string,
): Promise<{ owners: string[]; threshold: number } | null> {
  const events = await fetchAllEvents(childAddress);
  return parseChildConfigFromEvents(events, childAddress);
}

/** Parses JSON strings defensively when backend stores raw payload text. */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
