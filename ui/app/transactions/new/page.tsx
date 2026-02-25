'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppContext } from '../../layout';
import Header from '@/components/Header';
import ProposalForm, { ProposalData } from '@/components/ProposalForm';
import { Transaction } from '@/lib/types';

export default function NewTransactionPage() {
  const router = useRouter();
  const {
    wallet,
    multisig,
    transactions,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    addTransaction,
  } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (data: ProposalData) => {
    if (!wallet.address || !multisig) return;

    setIsSubmitting(true);
    try {
      // In production, this would:
      // 1. Create a TransactionProposal struct
      // 2. Generate a ZK proof via o1js
      // 3. Submit the transaction via Auro Wallet
      // For the MVP, we simulate by adding to local storage

      const nonce = transactions.length.toString();
      const tx: Transaction = {
        id: nonce,
        to: data.txType === 'transfer' ? data.to : '',
        amount:
          data.txType === 'transfer'
            ? (parseFloat(data.amount) * 1_000_000_000).toString()
            : '0',
        tokenId: '0',
        txType: data.txType,
        data:
          data.txType === 'changeThreshold'
            ? (data.newThreshold ?? 0).toString()
            : data.txType === 'addOwner'
            ? data.newOwner ?? ''
            : data.txType === 'removeOwner'
            ? data.removeOwnerAddress ?? ''
            : '0',
        nonce,
        txHash: Math.random().toString(36).slice(2), // placeholder
        status: 'pending',
        approvals: [wallet.address], // proposer auto-approves
        proposer: wallet.address,
        createdAt: Date.now(),
      };

      addTransaction(tx);

      // Navigate to the new transaction detail
      router.push(`/transactions/${tx.id}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <Header
        title="New Transaction"
        subtitle="Create a new multisig proposal"
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
            <p className="text-safe-text">
              Connect your wallet to create a transaction
            </p>
          </div>
        ) : (
          <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
            <ProposalForm
              owners={multisig.owners}
              currentThreshold={multisig.threshold}
              numOwners={multisig.numOwners}
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
            />
          </div>
        )}
      </div>
    </div>
  );
}
