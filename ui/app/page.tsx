'use client';

import { useAppContext } from './layout';
import Header from '@/components/Header';
import ThresholdBadge from '@/components/ThresholdBadge';
import TransactionList from '@/components/TransactionList';
import { formatMina, truncateAddress } from '@/lib/types';
import Link from 'next/link';

export default function Dashboard() {
  const {
    wallet,
    multisig,
    transactions,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
  } = useAppContext();

  const recentTxs = transactions.slice(-5).reverse();

  return (
    <div>
      <Header
        title="Dashboard"
        subtitle="Overview of your multisig wallet"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6">
        {!wallet.connected ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-safe-gray border border-safe-border rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-safe-text"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2">
              Connect your wallet
            </h3>
            <p className="text-sm text-safe-text mb-6 max-w-sm mx-auto">
              Connect your Auro Wallet to view and manage your multisig
              wallet
            </p>
            <button
              onClick={connect}
              className="bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
            >
              {auroInstalled ? 'Connect Auro Wallet' : 'Install Auro Wallet'}
            </button>
          </div>
        ) : multisig ? (
          <div className="space-y-6">
            {/* Balance + Info Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Balance Card */}
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">
                  Total Balance
                </p>
                <p className="text-3xl font-semibold">
                  {formatMina(multisig.balance)}{' '}
                  <span className="text-lg text-safe-text">MINA</span>
                </p>
              </div>

              {/* Threshold Card */}
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">
                  Threshold
                </p>
                <div className="flex items-center gap-3 mt-2">
                  <ThresholdBadge
                    threshold={multisig.threshold}
                    numOwners={multisig.numOwners}
                    size="lg"
                  />
                  <span className="text-xs text-safe-text">
                    required confirmations
                  </span>
                </div>
              </div>

              {/* Wallet Address Card */}
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">
                  Wallet Address
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <p className="text-sm font-mono">
                    {truncateAddress(multisig.address, 8)}
                  </p>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(multisig.address)
                    }
                    className="p-1 text-safe-text hover:text-white transition-colors"
                    title="Copy address"
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
                        strokeWidth={1.5}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="flex gap-3">
              <Link
                href="/transactions/new"
                className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2.5 text-sm hover:brightness-110 transition-all"
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
              <Link
                href="/settings"
                className="flex items-center gap-2 bg-safe-gray border border-safe-border text-white rounded-lg px-5 py-2.5 text-sm hover:bg-safe-hover transition-colors"
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
                    strokeWidth={1.5}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                Settings
              </Link>
            </div>

            {/* Recent Transactions */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">
                  Recent Transactions
                </h3>
                <Link
                  href="/transactions"
                  className="text-xs text-safe-green hover:underline"
                >
                  View all
                </Link>
              </div>
              <TransactionList
                transactions={recentTxs}
                threshold={multisig.threshold}
                owners={multisig.owners}
                emptyMessage="No transactions yet. Create your first one!"
              />
            </div>
          </div>
        ) : (
          <div className="text-center py-20">
            <p className="text-safe-text">Loading multisig state...</p>
          </div>
        )}
      </div>
    </div>
  );
}
