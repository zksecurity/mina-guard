// ── Off-chain Storage (localStorage-backed for MVP) ──────────────────

import { Transaction, MultisigState, TxStatus } from './types';

const STORAGE_KEY_PREFIX = 'mina-multisig-';

function getKey(walletAddress: string, suffix: string): string {
  return `${STORAGE_KEY_PREFIX}${walletAddress}-${suffix}`;
}

// ── Transactions ─────────────────────────────────────────────────────

export function getTransactions(walletAddress: string): Transaction[] {
  if (typeof window === 'undefined') return [];
  const key = getKey(walletAddress, 'transactions');
  const data = localStorage.getItem(key);
  if (!data) return [];
  return JSON.parse(data) as Transaction[];
}

export function saveTransactions(
  walletAddress: string,
  transactions: Transaction[]
): void {
  if (typeof window === 'undefined') return;
  const key = getKey(walletAddress, 'transactions');
  localStorage.setItem(key, JSON.stringify(transactions));
}

export function addTransaction(
  walletAddress: string,
  tx: Transaction
): void {
  const txs = getTransactions(walletAddress);
  txs.push(tx);
  saveTransactions(walletAddress, txs);
}

export function updateTransaction(
  walletAddress: string,
  txId: string,
  updates: Partial<Transaction>
): void {
  const txs = getTransactions(walletAddress);
  const idx = txs.findIndex((t) => t.id === txId);
  if (idx >= 0) {
    txs[idx] = { ...txs[idx], ...updates };
    saveTransactions(walletAddress, txs);
  }
}

export function getTransactionsByStatus(
  walletAddress: string,
  status: TxStatus
): Transaction[] {
  return getTransactions(walletAddress).filter((t) => t.status === status);
}

// ── Multisig State ───────────────────────────────────────────────────

export function getMultisigState(
  walletAddress: string
): MultisigState | null {
  if (typeof window === 'undefined') return null;
  const key = getKey(walletAddress, 'state');
  const data = localStorage.getItem(key);
  if (!data) return null;
  return JSON.parse(data) as MultisigState;
}

export function saveMultisigState(
  walletAddress: string,
  state: MultisigState
): void {
  if (typeof window === 'undefined') return;
  const key = getKey(walletAddress, 'state');
  localStorage.setItem(key, JSON.stringify(state));
}

// ── Merkle Data (raw JSON of MerkleMap serialization) ────────────────

export function getMerkleData(walletAddress: string): string | null {
  if (typeof window === 'undefined') return null;
  const key = getKey(walletAddress, 'merkle');
  return localStorage.getItem(key);
}

export function saveMerkleData(
  walletAddress: string,
  data: string
): void {
  if (typeof window === 'undefined') return;
  const key = getKey(walletAddress, 'merkle');
  localStorage.setItem(key, data);
}

// ── Clear all data for a wallet ──────────────────────────────────────

export function clearWalletData(walletAddress: string): void {
  if (typeof window === 'undefined') return;
  const suffixes = ['transactions', 'state', 'merkle'];
  for (const suffix of suffixes) {
    localStorage.removeItem(getKey(walletAddress, suffix));
  }
}
