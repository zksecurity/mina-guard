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
import { setLedgerNetworkId } from '@/lib/ledgerWallet';
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
    connect, connectAuro, connectLedger, disconnect, setNetwork,
  } = useWallet();

  const setWalletNetwork = useCallback((network: string, ledgerNetId: number) => {
    setNetwork(network);
    setLedgerNetworkId(ledgerNetId);
  }, [setNetwork]);

  const {
    state: multisig,
    contracts,
    owners,
    allContractOwners,
    indexerStatus,
    refreshState: refreshMultisig,
    selectContract,
  } = useMultisig(wallet.address);

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
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [operationBanner, setOperationBanner] = useState<OperationBanner | null>(null);
  const refreshRef = useRef(refreshMultisig);
  refreshRef.current = refreshMultisig;
  const currentLabelRef = useRef('');

  const clearBanner = useCallback(() => setOperationBanner(null), []);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss success banners after 30s
  useEffect(() => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    if (operationBanner?.type === 'success') {
      autoDismissRef.current = setTimeout(() => setOperationBanner(null), 30000);
    }
    return () => { if (autoDismissRef.current) clearTimeout(autoDismissRef.current); };
  }, [operationBanner]);

  const startOperation = useCallback(
    async (label: string, fn: (onProgress: (step: string) => void) => Promise<string | null>) => {
      setIsOperating(true);
      setOperationLabel(label);
      setCompletedSteps([]);
      setOperationBanner(null);
      currentLabelRef.current = label;

      const onProgress = (step: string) => {
        if (step === currentLabelRef.current) return;
        const prev = currentLabelRef.current;
        currentLabelRef.current = step;
        setOperationLabel(step);
        setCompletedSteps((steps) =>
          steps.includes(prev) ? steps : [...steps, prev]
        );
      };

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
        setWalletNetwork,
      }}
    >
      <div className="flex min-h-screen">
        <Sidebar
          multisigAddress={multisig?.address ?? null}
          contracts={contracts}
          pendingTxCount={pendingCount}
          indexerStatus={indexerStatus}
          onSelectContract={(address) => {
            void selectContract(address);
          }}
          walletAddress={wallet.address}
          allContractOwners={allContractOwners}
        />
        <main className="flex-1 min-h-screen">
          {children}
        </main>

        {/* Fixed toast notifications – bottom-right corner */}
        {(isOperating || operationBanner) && (
          <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 w-96 max-w-[calc(100vw-3rem)]">
            {isOperating && (
              <div className="animate-toast-in rounded-xl px-4 py-3 text-sm bg-safe-gray border border-safe-border shadow-lg shadow-black/40">
                <div className="space-y-2">
                  {completedSteps.map((step, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <svg className="shrink-0 w-3.5 h-3.5 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-safe-text/60 text-xs truncate">{step.replace(/\.{3}$/, '')}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <span className="animate-spin shrink-0 w-3.5 h-3.5 border-2 border-safe-green border-t-transparent rounded-full" />
                    <span className="text-safe-text text-xs truncate">{operationLabel}</span>
                  </div>
                </div>
              </div>
            )}
            {operationBanner && (
              <div
                className={`animate-toast-in flex items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-lg shadow-black/40 ${
                  operationBanner.type === 'success'
                    ? 'bg-safe-gray border border-safe-green/40 text-safe-green'
                    : 'bg-safe-gray border border-red-500/40 text-red-400'
                }`}
              >
                <span className="shrink-0 text-base">
                  {operationBanner.type === 'success' ? '\u2713' : '\u2717'}
                </span>
                <span className="font-mono text-xs break-all flex-1">
                  {(() => {
                    const explorerUrl = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? '';
                    const match = operationBanner.message.match(/^(Transaction submitted: )(5J\w+)$/);
                    if (match && explorerUrl) {
                      return (
                        <>
                          {match[1]}
                          <a
                            href={`${explorerUrl}/tx/${match[2]}?network=${wallet.network ?? ''}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:opacity-70"
                          >
                            {match[2]}
                          </a>
                        </>
                      );
                    }
                    return operationBanner.message;
                  })()}
                </span>
                <button onClick={clearBanner} className="shrink-0 hover:opacity-70 text-lg leading-none">
                  &times;
                </button>
              </div>
            )}
          </div>
        )}
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
