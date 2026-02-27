'use client';

import { createContext, useContext } from 'react';
import { WalletState, MultisigState, Transaction } from '@/lib/types';

export interface AppContextType {
  wallet: WalletState;
  multisig: MultisigState | null;
  transactions: Transaction[];
  pendingCount: number;
  connect: () => void;
  disconnect: () => void;
  isLoading: boolean;
  auroInstalled: boolean;
  addTransaction: (tx: Transaction) => void;
  updateTransaction: (txId: string, updates: Partial<Transaction>) => void;
  refreshMultisig: () => void;
}

export const AppContext = createContext<AppContextType>({
  wallet: { connected: false, address: null, network: null },
  multisig: null,
  transactions: [],
  pendingCount: 0,
  connect: () => {},
  disconnect: () => {},
  isLoading: false,
  auroInstalled: false,
  addTransaction: () => {},
  updateTransaction: () => {},
  refreshMultisig: () => {},
});

export const useAppContext = () => useContext(AppContext);
