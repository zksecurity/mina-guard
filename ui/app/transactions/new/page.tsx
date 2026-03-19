'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import ProposalForm from '@/components/ProposalForm';
import { type NewProposalInput, type TxType } from '@/lib/types';
import { createOffchainProposal } from '@/lib/multisigClient';
import { fetchContract } from '@/lib/api';

const TX_TYPES: { value: TxType; label: string }[] = [
  { value: 'transfer', label: 'Send MINA' },
  { value: 'addOwner', label: 'Add Owner' },
  { value: 'removeOwner', label: 'Remove Owner' },
  { value: 'changeThreshold', label: 'Change Threshold' },
  { value: 'setDelegate', label: 'Set Delegate' },
];

/** Proposal creation page that submits real MinaGuard propose transactions. */
export default function NewTransactionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    wallet,
    multisig,
    owners,
    proposals,
    connect,
    connectAuro,
    connectLedger,
    disconnect,
    isLoading,
    auroInstalled,
    ledgerSupported,
    startOperation,
    isOperating,
  } = useAppContext();

  const initialType = (searchParams.get('type') as TxType | null) ?? 'transfer';
  const [txType, setTxType] = useState<TxType>(initialType);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (data: NewProposalInput) => {
    if (!wallet.address || !multisig) return;
    setError(null);

    const contractAddress = multisig.address;
    const proposerAddress = wallet.address;
    const networkId = multisig.networkId ?? '0';
    const fallbackConfigNonce = multisig.configNonce ?? 0;
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;

    startOperation('Creating offchain proposal...', async (onProgress) => {
      const fresh = await fetchContract(contractAddress);
      const configNonce = fresh?.configNonce ?? fallbackConfigNonce;
      const result = await createOffchainProposal({
        contractAddress,
        proposerAddress,
        input: data,
        configNonce,
        networkId,
      }, onProgress, signer);
      router.push('/transactions');
      return result;
    });
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
        ledgerSupported={ledgerSupported}
        walletType={wallet.type}
        onConnect={connect}
        onConnectAuro={connectAuro}
        onConnectLedger={connectLedger}
        onDisconnect={disconnect}
      />

      <div className="p-6 max-w-2xl">
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect your wallet and select a contract to create proposals.</p>
          </div>
        ) : multisig.ownersCommitment == null ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Contract not initialized. Run Setup first before creating proposals.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {TX_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setTxType(type.value)}
                  className={`p-3 rounded-lg border text-sm text-left transition-colors ${
                    txType === type.value
                      ? 'border-safe-green text-safe-green bg-safe-hover'
                      : 'border-safe-border text-safe-text hover:border-safe-text'
                  }`}
                >
                  {type.label}
                </button>
              ))}
            </div>

            <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
              {proposals.some(
                (p) =>
                  p.status === 'pending' &&
                  p.txType &&
                  ['addOwner', 'removeOwner', 'changeThreshold', 'setDelegate'].includes(p.txType)
              ) && (
                <div className="rounded-lg px-4 py-3 text-xs bg-yellow-400/10 text-yellow-400 border border-yellow-400/30">
                  There are pending governance proposals. If one executes before this proposal, the config nonce will change and this proposal will be invalidated.
                </div>
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
              <ProposalForm
                owners={owners.map((owner) => owner.address)}
                currentThreshold={multisig.threshold ?? 1}
                numOwners={multisig.numOwners ?? owners.length}
                onSubmit={handleSubmit}
                isSubmitting={isOperating}
                txType={txType}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
