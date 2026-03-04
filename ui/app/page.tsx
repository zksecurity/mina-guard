'use client';

import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import ThresholdBadge from '@/components/ThresholdBadge';
import TransactionList from '@/components/TransactionList';
import { truncateAddress } from '@/lib/types';
import Link from 'next/link';

/** Dashboard overview page for selected contract and latest indexed proposals. */
export default function Dashboard() {
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

  const recent = [...proposals].slice(0, 5);

  return (
    <div>
      <Header
        title="Dashboard"
        subtitle="Overview of indexed MinaGuard multisig activity"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6">
        {!wallet.connected ? (
          <ConnectNotice onConnect={connect} auroInstalled={auroInstalled} />
        ) : multisig ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Contract</p>
                <p className="text-sm font-mono">{truncateAddress(multisig.address, 10)}</p>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Threshold</p>
                <div className="flex items-center gap-3 mt-2">
                  <ThresholdBadge
                    threshold={multisig.threshold ?? 0}
                    numOwners={multisig.numOwners ?? owners.length}
                    size="lg"
                  />
                  <span className="text-xs text-safe-text">required approvals</span>
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Indexer Status</p>
                <p className="text-sm">
                  {indexerStatus?.running ? 'Running' : 'Stopped'}
                  {indexerStatus?.lastSuccessfulRunAt
                    ? ` · synced ${new Date(indexerStatus.lastSuccessfulRunAt).toLocaleTimeString()}`
                    : ''}
                </p>
                {indexerStatus?.lastError && (
                  <p className="text-xs text-red-400 mt-1 truncate" title={indexerStatus.lastError}>
                    {indexerStatus.lastError}
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <Link
                href="/transactions/new"
                className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2.5 text-sm hover:brightness-110 transition-all"
              >
                New Proposal
              </Link>
              <Link
                href="/deploy"
                className="flex items-center gap-2 bg-safe-gray border border-safe-border text-white rounded-lg px-5 py-2.5 text-sm hover:bg-safe-hover transition-colors"
              >
                Deploy / Setup
              </Link>
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
            <p className="text-safe-text">No MinaGuard contracts discovered yet. Open Deploy to initialize one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Connect-wallet empty state shown when no wallet session is active. */
function ConnectNotice({
  onConnect,
  auroInstalled,
}: {
  onConnect: () => void;
  auroInstalled: boolean;
}) {
  return (
    <div className="text-center py-20">
      <h3 className="text-lg font-semibold mb-2">Connect your wallet</h3>
      <p className="text-sm text-safe-text mb-6 max-w-sm mx-auto">
        Connect your Auro Wallet to create and approve MinaGuard proposals.
      </p>
      <button
        onClick={onConnect}
        className="bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
      >
        {auroInstalled ? 'Connect Auro Wallet' : 'Install Auro Wallet'}
      </button>
    </div>
  );
}
