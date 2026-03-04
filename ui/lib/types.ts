// -- UI Types ---------------------------------------------------------

/** Indexed proposal lifecycle status used by list/detail screens. */
export type ProposalStatus = 'pending' | 'executed' | 'expired';

/** Frontend-friendly transaction type labels mapped from MinaGuard TxType values. */
export type TxType =
  | 'transfer'
  | 'addOwner'
  | 'removeOwner'
  | 'changeThreshold'
  | 'setDelegate';

/** Proposal record returned by the backend indexer API. */
export interface Proposal {
  proposalHash: string;
  proposer: string | null;
  toAddress: string | null;
  amount: string | null;
  tokenId: string | null;
  txType: TxType | null;
  data: string | null;
  nonce: string | null;
  configNonce: string | null;
  expiryBlock: string | null;
  networkId: string | null;
  guardAddress: string | null;
  status: ProposalStatus;
  approvalCount: number;
  createdAtBlock: number | null;
  executedAtBlock: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Indexed owner membership record for one MinaGuard contract. */
export interface OwnerRecord {
  address: string;
  ownerHash: string | null;
  index: number | null;
  active: boolean;
}

/** Contract summary returned by backend contract listing endpoints. */
export interface ContractSummary {
  address: string;
  networkId: string | null;
  ownersRoot: string | null;
  threshold: number | null;
  numOwners: number | null;
  proposalNonce: number | null;
  configNonce: number | null;
  isValid: boolean;
  invalidReason: string | null;
  discoveredAt: string;
  lastSyncedAt: string | null;
}

/** Per-proposal approval row exposed by backend approval endpoints. */
export interface ApprovalRecord {
  approver: string;
  approvalRaw: string | null;
  blockHeight: number | null;
  createdAt: string;
}

/** Runtime wallet session state for Auro integration. */
export interface WalletState {
  connected: boolean;
  address: string | null;
  network: string | null;
}

/** Polling indexer health details exposed by backend status endpoint. */
export interface IndexerStatus {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  latestChainHeight: number;
  indexedHeight: number;
  lastError: string | null;
  discoveredContracts: number;
}

/** User input payload used by proposal creation forms. */
export interface NewProposalInput {
  txType: TxType;
  to?: string;
  amount?: string;
  newOwner?: string;
  removeOwnerAddress?: string;
  newThreshold?: number;
  delegate?: string;
  undelegate?: boolean;
  expiryBlock?: number;
}

export const TX_TYPE_LABELS: Record<TxType, string> = {
  transfer: 'Send',
  addOwner: 'Add Owner',
  removeOwner: 'Remove Owner',
  changeThreshold: 'Change Threshold',
  setDelegate: 'Set Delegate',
};

/** Truncates long addresses for compact UI chips and labels. */
export function truncateAddress(addr: string, chars: number = 6): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

/** Formats nanomina string values into human-readable MINA decimal text. */
export function formatMina(nanomina: string | null): string {
  if (!nanomina) return '0';
  const NANO = 1_000_000_000;
  const n = Number(nanomina);
  if (!Number.isFinite(n)) return '0';
  const whole = Math.floor(n / NANO);
  const frac = n % NANO;
  if (frac === 0) return whole.toString();
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/** Parses serialized numeric tx type values into UI-friendly tx type identifiers. */
export function parseTxType(value: string | null): TxType | null {
  if (value === null) return null;
  switch (value) {
    case '0':
      return 'transfer';
    case '1':
      return 'addOwner';
    case '2':
      return 'removeOwner';
    case '3':
      return 'changeThreshold';
    case '4':
      return 'setDelegate';
    default:
      return null;
  }
}

/** Parses backend tx type strings to preserve already-humanized values when present. */
export function normalizeTxType(value: string | null): TxType | null {
  if (!value) return null;
  if (
    value === 'transfer' ||
    value === 'addOwner' ||
    value === 'removeOwner' ||
    value === 'changeThreshold' ||
    value === 'setDelegate'
  ) {
    return value;
  }

  return parseTxType(value);
}
