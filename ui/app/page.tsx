'use client';

import { useEffect, useState } from 'react';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import ThresholdBadge from '@/components/ThresholdBadge';
import TransactionList from '@/components/TransactionList';
import { truncateAddress, formatMina } from '@/lib/types';
import { fetchBalance } from '@/lib/api';
import Link from 'next/link';

const TX_TYPES = [
  { value: 'transfer', label: 'Send MINA' },
  { value: 'addOwner', label: 'Add Owner' },
  { value: 'removeOwner', label: 'Remove Owner' },
  { value: 'changeThreshold', label: 'Change Threshold' },
  { value: 'setDelegate', label: 'Set Delegate' },
] as const;

/** Dashboard overview page for selected contract and latest indexed proposals. */
export default function Dashboard() {
  const {
    wallet,
    multisig,
    owners,
    proposals,
    indexerStatus,
    connect,
    connectAuro,
    connectLedger,
    disconnect,
    isLoading,
    walletError,
    clearWalletError,
    auroInstalled,
    ledgerSupported,
  } = useAppContext();

  const recent = [...proposals].slice(0, 5);

  const [balance, setBalance] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);

  useEffect(() => {
    if (!multisig?.address) return;
    fetchBalance(multisig.address).then((b) => setBalance(b));
  }, [multisig?.address, indexerStatus?.lastSuccessfulRunAt]);

  return (
    <div>
      <Header
        title="Dashboard"
        subtitle=""
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        ledgerSupported={ledgerSupported}
        walletType={wallet.type}
        onConnect={connect}
        onConnectAuro={connectAuro}
        onConnectLedger={connectLedger}
        onDisconnect={disconnect}
      />

      <div className="p-6">
        {!wallet.connected ? (
          <ConnectNotice
            onConnectAuro={connectAuro}
            onConnectLedger={connectLedger}
            auroInstalled={auroInstalled}
            ledgerSupported={ledgerSupported}
            error={walletError}
            onClearError={clearWalletError}
          />
        ) : multisig ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Wallet Address</p>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-mono flex min-w-0">
                    <span className="truncate">{multisig.address.slice(0, -4)}</span>
                    <span className="shrink-0">{multisig.address.slice(-4)}</span>
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(multisig.address);
                      setCopiedAddress(true);
                      setTimeout(() => setCopiedAddress(false), 1500);
                    }}
                    title="Copy address"
                    className="text-safe-text hover:text-white transition-colors"
                  >
                    {copiedAddress ? (
                      <svg className="w-3.5 h-3.5 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Threshold</p>
                <div className="mt-2">
                  <ThresholdBadge
                    threshold={multisig.threshold ?? 0}
                    numOwners={multisig.numOwners ?? owners.length}
                    size="lg"
                  />
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Wallet Balance</p>
                <p className="text-lg font-semibold mt-1">
                  {balance !== null ? formatMina(balance) : '-'}{' '}
                  <span className="text-sm text-safe-text font-normal">MINA</span>
                </p>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Block Producer Delegate</p>
                <p className="text-sm font-mono mt-1 truncate" title={multisig.delegate ?? undefined}>
                  {multisig.delegate ? truncateAddress(multisig.delegate, 10) : 'None'}
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-base font-bold mb-3">New Proposal</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {TX_TYPES.map((type) => (
                  <Link
                    key={type.value}
                    href={`/transactions/new?type=${type.value}`}
                    className="p-3 rounded-lg border border-safe-border bg-safe-gray text-sm text-white font-medium text-left transition-colors hover:border-safe-green hover:text-safe-green"
                  >
                    {type.label}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">Recent Proposals</h3>
                <Link href="/transactions" className="text-xs text-safe-green hover:underline">
                  View all
                </Link>
              </div>
              <TransactionList
                proposals={recent}
                threshold={multisig.threshold ?? 0}
                owners={owners.map((owner) => owner.address)}
                emptyMessage="No proposals indexed yet"
              />
            </div>
          </div>
        ) : (
          <div className="text-center py-20">
            <p className="text-safe-text mb-4">No MinaGuard contracts discovered yet.</p>
            <Link
              href="/deploy"
              className="inline-block bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
            >
              Deploy Contract
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** Connect-wallet empty state shown when no wallet session is active. */
function ConnectNotice({
  onConnectAuro,
  onConnectLedger,
  auroInstalled,
  ledgerSupported,
  error,
  onClearError,
}: {
  onConnectAuro: () => void;
  onConnectLedger: (accountIndex?: number) => void;
  auroInstalled: boolean;
  ledgerSupported: boolean;
  error: string | null;
  onClearError: () => void;
}) {
  const [showLedgerModal, setShowLedgerModal] = useState(false);

  return (
    <div className="text-center py-20">
      <h3 className="text-lg font-semibold mb-2">Connect your wallet</h3>
      <p className="text-sm text-safe-text mb-6 max-w-sm mx-auto">
        Connect with Auro Wallet or Ledger to create and approve MinaGuard proposals.
      </p>
      {error && (
        <div className="flex items-center justify-center gap-2 mb-4 mx-auto max-w-md rounded-lg px-4 py-3 text-sm bg-red-500/10 text-red-400 border border-red-500/30">
          <span>{error}</span>
          <button onClick={onClearError} className="ml-2 shrink-0 hover:opacity-70">&times;</button>
        </div>
      )}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={onConnectAuro}
          className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {auroInstalled ? 'Connect Auro' : 'Install Auro'}
        </button>
        {ledgerSupported && (
          <button
            onClick={() => setShowLedgerModal(true)}
            className="flex items-center gap-2 bg-safe-gray border border-safe-border text-white font-semibold rounded-lg px-6 py-3 text-sm hover:bg-safe-hover transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Connect Ledger
          </button>
        )}
      </div>
      {showLedgerModal && (
        <LedgerConnectModal
          onConfirm={(accountIndex, _networkId) => {
            // TODO: wire networkId to Ledger signing calls
            setShowLedgerModal(false);
            onConnectLedger(accountIndex);
          }}
          onClose={() => setShowLedgerModal(false)}
        />
      )}
    </div>
  );
}
