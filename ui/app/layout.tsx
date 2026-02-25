'use client';

import './globals.css';
import { useState } from 'react';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import { useWallet } from '@/hooks/useWallet';
import { useMultisig } from '@/hooks/useMultisig';
import { useTransactions } from '@/hooks/useTransactions';

// Context for sharing wallet/multisig state across pages
import { createContext, useContext } from 'react';
import { WalletState, MultisigState, Transaction } from '@/lib/types';

interface AppContextType {
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

function AppProvider({ children }: { children: React.ReactNode }) {
  const { wallet, isLoading, auroInstalled, connect, disconnect } =
    useWallet();

  const {
    state: multisig,
    refreshState: refreshMultisig,
  } = useMultisig(wallet.address);

  const {
    transactions,
    pendingCount,
    addTransaction,
    updateTransaction,
  } = useTransactions(multisig?.address ?? null);

  return (
    <AppContext.Provider
      value={{
        wallet,
        multisig,
        transactions,
        pendingCount,
        connect,
        disconnect,
        isLoading,
        auroInstalled,
        addTransaction,
        updateTransaction,
        refreshMultisig,
      }}
    >
      <div className="flex min-h-screen">
        <Sidebar
          walletAddress={wallet.address}
          multisigAddress={multisig?.address ?? null}
          pendingTxCount={pendingCount}
          network={wallet.network}
        />
        <main className="flex-1 min-h-screen">{children}</main>
      </div>
    </AppContext.Provider>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
