'use client';

import './globals.css';
import Sidebar from '@/components/Sidebar';
import { useWallet } from '@/hooks/useWallet';
import { useMultisig } from '@/hooks/useMultisig';
import { useTransactions } from '@/hooks/useTransactions';
import { AppContext } from '@/lib/app-context';

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
