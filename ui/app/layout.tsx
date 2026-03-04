'use client';

import './globals.css';
import Sidebar from '@/components/Sidebar';
import { useWallet } from '@/hooks/useWallet';
import { useMultisig } from '@/hooks/useMultisig';
import { useTransactions } from '@/hooks/useTransactions';
import { AppContext } from '@/lib/app-context';

/** Root-level provider that wires wallet state with backend-indexed contract data. */
function AppProvider({ children }: { children: React.ReactNode }) {
  const { wallet, isLoading: walletLoading, auroInstalled, connect, disconnect } =
    useWallet();

  const {
    state: multisig,
    contracts,
    owners,
    indexerStatus,
    isLoading: multisigLoading,
    refreshState: refreshMultisig,
    selectContract,
  } = useMultisig();

  const {
    proposals,
    isLoading: proposalsLoading,
    pendingCount,
  } = useTransactions(multisig?.address ?? null);

  return (
    <AppContext.Provider
      value={{
        wallet,
        multisig,
        contracts,
        owners,
        proposals,
        pendingCount,
        indexerStatus,
        connect,
        disconnect,
        isLoading: walletLoading || multisigLoading || proposalsLoading,
        auroInstalled,
        refreshMultisig,
        selectContract,
      }}
    >
      <div className="flex min-h-screen">
        <Sidebar
          walletAddress={wallet.address}
          multisigAddress={multisig?.address ?? null}
          contracts={contracts.map((c) => c.address)}
          pendingTxCount={pendingCount}
          network={wallet.network}
          onSelectContract={(address) => {
            void selectContract(address);
          }}
        />
        <main className="flex-1 min-h-screen">{children}</main>
      </div>
    </AppContext.Provider>
  );
}

/** App router root layout entrypoint. */
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
