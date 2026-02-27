'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import OwnerList from '@/components/OwnerList';
import ThresholdBadge from '@/components/ThresholdBadge';

export default function SettingsPage() {
  const router = useRouter();
  const {
    wallet,
    multisig,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
  } = useAppContext();

  const handleAddOwner = () => {
    router.push('/transactions/new');
  };

  const handleRemoveOwner = (address: string) => {
    router.push('/transactions/new');
  };

  const handleChangeThreshold = () => {
    router.push('/transactions/new');
  };

  return (
    <div>
      <Header
        title="Settings"
        subtitle="Manage owners and threshold"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6 max-w-2xl space-y-6">
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">
              Connect your wallet to manage settings
            </p>
          </div>
        ) : (
          <>
            {/* Threshold Section */}
            <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold">
                    Required Confirmations
                  </h3>
                  <p className="text-xs text-safe-text mt-1">
                    Transactions require this many owner confirmations
                  </p>
                </div>
                <ThresholdBadge
                  threshold={multisig.threshold}
                  numOwners={multisig.numOwners}
                  size="lg"
                />
              </div>
              <button
                onClick={handleChangeThreshold}
                className="w-full mt-2 p-2.5 border border-safe-border rounded-lg text-sm text-safe-text hover:text-safe-green hover:border-safe-green transition-colors"
              >
                Change Threshold
              </button>
              <p className="text-[10px] text-safe-text mt-2">
                Changing the threshold requires a multisig proposal approved
                by the current threshold of owners.
              </p>
            </div>

            {/* Owners Section */}
            <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
              <div className="mb-4">
                <h3 className="text-sm font-semibold">
                  Owners ({multisig.numOwners})
                </h3>
                <p className="text-xs text-safe-text mt-1">
                  Owners can propose, confirm, and execute transactions
                </p>
              </div>
              <OwnerList
                owners={multisig.owners}
                currentUser={wallet.address}
                threshold={multisig.threshold}
                onAddOwner={handleAddOwner}
                onRemoveOwner={handleRemoveOwner}
              />
              <p className="text-[10px] text-safe-text mt-3">
                Adding or removing owners requires a multisig proposal
                approved by the current threshold of owners.
              </p>
            </div>

            {/* Wallet Info Section */}
            <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">Wallet Info</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-safe-border/50">
                  <span className="text-sm text-safe-text">
                    Contract Address
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono">
                      {multisig.address.slice(0, 12)}...
                      {multisig.address.slice(-8)}
                    </span>
                    <button
                      onClick={() =>
                        navigator.clipboard.writeText(multisig.address)
                      }
                      className="p-1 text-safe-text hover:text-white transition-colors"
                    >
                      <svg
                        className="w-3.5 h-3.5"
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
                <div className="flex justify-between items-center py-2 border-b border-safe-border/50">
                  <span className="text-sm text-safe-text">Network</span>
                  <span className="text-sm">{wallet.network ?? 'Unknown'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-safe-border/50">
                  <span className="text-sm text-safe-text">
                    Transaction Nonce
                  </span>
                  <span className="text-sm font-mono">
                    {multisig.txNonce}
                  </span>
                </div>
                <div className="flex justify-between items-center py-2">
                  <span className="text-sm text-safe-text">
                    Config Nonce
                  </span>
                  <span className="text-sm font-mono">
                    {multisig.configNonce}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
