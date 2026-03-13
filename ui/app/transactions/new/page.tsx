'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import ProposalForm from '@/components/ProposalForm';
import { type NewProposalInput } from '@/lib/types';
import { createProposeTx } from '@/lib/multisigClient';

/** Proposal creation page that submits real MinaGuard propose transactions. */
export default function NewTransactionPage() {
  const router = useRouter();
  const {
    wallet,
    multisig,
    owners,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    refreshMultisig,
  } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Builds and submits propose tx, then refreshes indexer-backed state. */
  const handleSubmit = async (data: NewProposalInput) => {
    if (!wallet.address || !multisig) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const txHash = await createProposeTx({
        contractAddress: multisig.address,
        proposerAddress: wallet.address,
        input: data,
      });

      if (!txHash) {
        setError('Failed to submit proposal transaction.');
        return;
      }

      await refreshMultisig();
      router.push('/transactions');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Proposal submission failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <Header
        title="New Proposal"
        subtitle="Create and submit a MinaGuard proposal"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6 max-w-2xl">
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect your wallet and select a contract to create proposals.</p>
          </div>
        ) : multisig.ownersRoot == null ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Contract not initialized. Run Setup first before creating proposals.</p>
          </div>
        ) : (
          <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
            {error && <p className="text-sm text-red-400">{error}</p>}
            <ProposalForm
              owners={owners.map((owner) => owner.address)}
              currentThreshold={multisig.threshold ?? 1}
              numOwners={multisig.numOwners ?? owners.length}
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
            />
          </div>
        )}
      </div>
    </div>
  );
}
