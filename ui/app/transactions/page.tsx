'use client';

import { useState } from 'react';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import TransactionList from '@/components/TransactionList';
import Link from 'next/link';
import { TxStatus } from '@/lib/types';

type Tab = 'all' | 'pending' | 'executed';

export default function TransactionsPage() {
  const {
    wallet,
    multisig,
    transactions,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
  } = useAppContext();
  const [activeTab, setActiveTab] = useState<Tab>('all');

  const filteredTxs =
    activeTab === 'all'
      ? transactions
      : transactions.filter((t) => t.status === activeTab);

  const pendingCount = transactions.filter(
    (t) => t.status === 'pending'
  ).length;
  const executedCount = transactions.filter(
    (t) => t.status === 'executed'
  ).length;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: transactions.length },
    { key: 'pending', label: 'Pending', count: pendingCount },
    { key: 'executed', label: 'Executed', count: executedCount },
  ];

  return (
    <div>
      <Header
        title="Transactions"
        subtitle="View and manage multisig transactions"
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
            <p className="text-safe-text">
              Connect your wallet to view transactions
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Tabs + New TX button */}
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
                    <span className="ml-1.5 text-xs opacity-60">
                      {tab.count}
                    </span>
                  </button>
                ))}
              </div>

              <Link
                href="/transactions/new"
                className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm hover:brightness-110 transition-all"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                New Transaction
              </Link>
            </div>

            {/* Transaction list */}
            <TransactionList
              transactions={[...filteredTxs].reverse()}
              threshold={multisig.threshold}
              owners={multisig.owners}
              emptyMessage={
                activeTab === 'pending'
                  ? 'No pending transactions'
                  : activeTab === 'executed'
                  ? 'No executed transactions yet'
                  : 'No transactions yet'
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
