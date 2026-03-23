'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import { useWallet } from '@/hooks/useWallet';
import { useMultisig } from '@/hooks/useMultisig';
import { useTransactions } from '@/hooks/useTransactions';
import { AppContext, type OperationBanner } from '@/lib/app-context';
import { warmupWorker, onLedgerSigningChange, type LedgerSigningContext } from '@/lib/multisigClient';
import LedgerSigningModal from '@/components/LedgerSigningModal';

/** Root-level provider that wires wallet state with backend-indexed contract data. */
function AppProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => { warmupWorker(); }, []);

  // Expose client-side navigation for e2e tests (avoids full reload / worker restart)
  useEffect(() => {
    (window as any).__e2eNavigate = (path: string) => router.push(path);
    (window as any).__e2ePathname = () => pathname;
  }, [router, pathname]);

  const {
    wallet, isLoading: walletLoading, error: walletError, clearError: clearWalletError,
    auroInstalled, ledgerSupported,
    connect, connectAuro, connectLedger, disconnect,
  } = useWallet();

  const {
    state: multisig,
    contracts,
    owners,
    indexerStatus,
    refreshState: refreshMultisig,
    selectContract,
  } = useMultisig();

  const {
    proposals,
    pendingCount,
  } = useTransactions(multisig?.address ?? null);

  // Ledger signing popup state
  const [ledgerSigning, setLedgerSigning] = useState(false);
  const [ledgerContext, setLedgerContext] = useState<LedgerSigningContext>('signing');
  useEffect(() => onLedgerSigningChange((signing, context) => {
    setLedgerSigning(signing);
    if (context) setLedgerContext(context);
  }), []);

  // Global operation state for worker-based transactions
  const [isOperating, setIsOperating] = useState(false);
  const [operationLabel, setOperationLabel] = useState('');
  const [operationBanner, setOperationBanner] = useState<OperationBanner | null>(null);
  const refreshRef = useRef(refreshMultisig);
  refreshRef.current = refreshMultisig;

  const clearBanner = useCallback(() => setOperationBanner(null), []);

  const startOperation = useCallback(
    (label: string, fn: (onProgress: (step: string) => void) => Promise<string | null>) => {
      setIsOperating(true);
      setOperationLabel(label);
      setOperationBanner(null);

      const onProgress = (step: string) => setOperationLabel(step);

      (async () => {
        try {
          console.log('[startOperation] awaiting fn...');
          const result = await fn(onProgress);
          console.log('[startOperation] fn resolved:', result);
          if (!result) {
            setOperationBanner({ type: 'error', message: `${label.replace(/\.\.\.$/, '')} failed.` });
            return;
          }
          setOperationBanner({ type: 'success', message: result });
          console.log('[startOperation] refreshing state...');
          await refreshRef.current();
          console.log('[startOperation] refresh done');
        } catch (err) {
          console.error('[startOperation] error:', err);
          setOperationBanner({
            type: 'error',
            message: err instanceof Error ? err.message : `${label.replace(/\.\.\.$/, '')} failed`,
          });
        } finally {
          setIsOperating(false);
        }
      })();
    },
    []
  );

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
        connectAuro,
        connectLedger,
        disconnect: async () => { await disconnect(); clearBanner(); },
        isLoading: walletLoading,
        walletError,
        clearWalletError,
        auroInstalled,
        ledgerSupported,
        refreshMultisig,
        selectContract,
        isOperating,
        operationLabel,
        operationBanner,
        clearBanner,
        startOperation,
        ledgerSigning,
      }}
    >
      <div className="flex min-h-screen">
        <Sidebar
          multisigAddress={multisig?.address ?? null}
          contracts={contracts.map((c) => c.address)}
          pendingTxCount={pendingCount}
          indexerStatus={indexerStatus}
          onSelectContract={(address) => {
            void selectContract(address);
          }}
        />
        <main className="flex-1 min-h-screen">
          {operationBanner && (
            <div
              className={`flex items-center justify-between rounded-lg px-4 py-3 m-6 mb-0 text-sm ${
                operationBanner.type === 'success'
                  ? 'bg-safe-green/10 text-safe-green border border-safe-green/30'
                  : 'bg-red-500/10 text-red-400 border border-red-500/30'
              }`}
            >
              <span className="font-mono text-xs break-all">{operationBanner.message}</span>
              <button onClick={clearBanner} className="ml-3 shrink-0 hover:opacity-70">
                &times;
              </button>
            </div>
          )}
          {isOperating && (
            <div className="flex items-center gap-2 rounded-lg px-4 py-3 m-6 mb-0 text-sm bg-safe-gray border border-safe-border">
              <span className="animate-spin w-4 h-4 border-2 border-safe-green border-t-transparent rounded-full" />
              <span className="text-safe-text">{operationLabel}</span>
            </div>
          )}
          {children}
        </main>
        {ledgerSigning && <LedgerSigningModal context={ledgerContext} />}
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
