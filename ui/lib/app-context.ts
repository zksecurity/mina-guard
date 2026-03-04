'use client';

import { createContext, useContext } from 'react';
import {
  ContractSummary,
  IndexerStatus,
  OwnerRecord,
  Proposal,
  WalletState,
} from '@/lib/types';

/** Shared app context contract for wallet, contract index data, and refresh actions. */
export interface AppContextType {
  wallet: WalletState;
  multisig: ContractSummary | null;
  contracts: ContractSummary[];
  owners: OwnerRecord[];
  proposals: Proposal[];
  pendingCount: number;
  indexerStatus: IndexerStatus | null;
  connect: () => void;
  disconnect: () => void;
  isLoading: boolean;
  auroInstalled: boolean;
  refreshMultisig: () => Promise<void>;
  selectContract: (address: string) => Promise<void>;
}

export const AppContext = createContext<AppContextType>({
  wallet: { connected: false, address: null, network: null },
  multisig: null,
  contracts: [],
  owners: [],
  proposals: [],
  pendingCount: 0,
  indexerStatus: null,
  connect: () => {},
  disconnect: () => {},
  isLoading: false,
  auroInstalled: false,
  refreshMultisig: async () => {},
  selectContract: async () => {},
});

/** Hook wrapper for typed context consumption in client components. */
export const useAppContext = () => useContext(AppContext);
