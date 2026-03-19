'use client';

import { createContext, useContext } from 'react';
import {
  ContractSummary,
  IndexerStatus,
  OwnerRecord,
  Proposal,
  WalletState,
} from '@/lib/types';

/** Banner state displayed at the top of the Dashboard after an operation completes. */
export interface OperationBanner {
  type: 'success' | 'error';
  message: string;
}

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
  connectAuro: () => void;
  connectLedger: (accountIndex?: number) => void;
  disconnect: () => void;
  isLoading: boolean;
  /** Wallet connection error message (e.g. Ledger errors). */
  walletError: string | null;
  clearWalletError: () => void;
  auroInstalled: boolean;
  ledgerSupported: boolean;
  refreshMultisig: () => Promise<void>;
  selectContract: (address: string) => Promise<void>;
  /** Whether a worker operation is currently running. */
  isOperating: boolean;
  /** Spinner label shown while a worker task is in flight. */
  operationLabel: string;
  /** Result banner from the last completed operation. */
  operationBanner: OperationBanner | null;
  /** Clears the result banner. */
  clearBanner: () => void;
  /** Starts a worker operation: shows spinner, runs fn, shows result banner, refreshes state.
   *  The fn receives an onProgress callback to update the spinner label mid-operation. */
  startOperation: (label: string, fn: (onProgress: (step: string) => void) => Promise<string | null>) => void;
  /** Whether the Ledger device is currently awaiting user interaction. */
  ledgerSigning: boolean;
}

export const AppContext = createContext<AppContextType>({
  wallet: { connected: false, address: null, network: null, type: null },
  multisig: null,
  contracts: [],
  owners: [],
  proposals: [],
  pendingCount: 0,
  indexerStatus: null,
  connect: () => {},
  connectAuro: () => {},
  connectLedger: () => {},
  disconnect: () => {},
  isLoading: false,
  walletError: null,
  clearWalletError: () => {},
  auroInstalled: false,
  ledgerSupported: false,
  refreshMultisig: async () => {},
  selectContract: async () => {},
  isOperating: false,
  operationLabel: '',
  operationBanner: null,
  clearBanner: () => {},
  startOperation: () => {},
  ledgerSigning: false,
});

/** Hook wrapper for typed context consumption in client components. */
export const useAppContext = () => useContext(AppContext);
