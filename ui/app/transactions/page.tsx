'use client';

import { useState } from 'react';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import TransactionList from '@/components/TransactionList';
import Link from 'next/link';

type Tab = 'all' | 'pending' | 'executed' | 'expired';

/** Full proposal table page with lifecycle-status filtering tabs. */
export default function TransactionsPage() {
  const {
    wallet,
    multisig,
    owners,
    proposals,
    indexerStatus,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
  } = useAppContext();
  const [activeTab, setActiveTab] = useState<Tab>('all');

  const filtered =
    activeTab === 'all'
      ? proposals
      : proposals.filter((proposal) => proposal.status === activeTab);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: proposals.length },
    { key: 'pending', label: 'Pending', count: proposals.filter((p) => p.status === 'pending').length },
    { key: 'executed', label: 'Executed', count: proposals.filter((p) => p.status === 'executed').length },
    { key: 'expired', label: 'Expired', count: proposals.filter((p) => p.status === 'expired').length },
  ];

  return (
    <div>
      <Header
        title="Proposals"
        subtitle="Indexed MinaGuard proposals"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6">
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect wallet and select a contract to view proposals</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex gap-1 bg-safe-gray border border-safe-border rounded-lg p-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                      activeTab === tab.key
                        ? 'bg-safe-hover text-safe-green'
                        : 'text-safe-text hover:text-white'
                    }`}
                  >
                    {tab.label}
                    <span className="ml-1.5 text-xs opacity-60">{tab.count}</span>
                  </button>
                ))}
              </div>

              {multisig.ownersCommitment != null ? (
                <Link
                  href="/transactions/new"
                  className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm hover:brightness-110 transition-all"
                >
                  New Proposal
                </Link>
              ) : (
                <span
                  title="Run Setup first to initialize the contract"
                  className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm opacity-40 cursor-not-allowed"
                >
                  New Proposal
                </span>
              )}
            </div>

            <TransactionList
              proposals={filtered}
              threshold={multisig.threshold ?? 0}
              owners={owners.map((owner) => owner.address)}
              emptyMessage={
                activeTab === 'all'
                  ? 'No proposals found'
                  : `No ${activeTab} proposals`
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
