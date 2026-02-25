// ── UI Types ─────────────────────────────────────────────────────────

export type TxStatus = 'pending' | 'executed' | 'failed';
export type TxType =
  | 'transfer'
  | 'addOwner'
  | 'removeOwner'
  | 'changeThreshold'
  | 'registerGuard';

export interface Transaction {
  id: string; // txNonce as string
  to: string; // base58 address
  amount: string; // nanomina as string
  tokenId: string;
  txType: TxType;
  data: string; // extra data hash
  nonce: string;
  txHash: string;
  status: TxStatus;
  approvals: string[]; // base58 addresses of approvers
  proposer: string; // base58 address
  createdAt: number; // timestamp
  executedAt?: number;
}

export interface MultisigState {
  address: string;
  ownersRoot: string;
  threshold: number;
  numOwners: number;
  txNonce: number;
  owners: string[]; // base58 addresses
  balance: string; // nanomina
  configNonce: number;
}

export interface WalletState {
  connected: boolean;
  address: string | null;
  network: string | null;
}

export const TX_TYPE_LABELS: Record<TxType, string> = {
  transfer: 'Send',
  addOwner: 'Add Owner',
  removeOwner: 'Remove Owner',
  changeThreshold: 'Change Threshold',
  registerGuard: 'Register Module',
};

export function truncateAddress(addr: string, chars: number = 6): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function formatMina(nanomina: string): string {
  // Avoid BigInt literals for broader compatibility
  const NANO = 1_000_000_000;
  const n = Number(nanomina);
  const whole = Math.floor(n / NANO);
  const frac = n % NANO;
  if (frac === 0) return whole.toString();
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
