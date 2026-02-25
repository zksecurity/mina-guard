'use client';

import { useParams, useRouter } from 'next/navigation';
import { useAppContext } from '../../layout';
import Header from '@/components/Header';
import ApprovalProgress from '@/components/ApprovalProgress';
import {
  TX_TYPE_LABELS,
  truncateAddress,
  formatMina,
} from '@/lib/types';

export default function TransactionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const {
    wallet,
    multisig,
    transactions,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    updateTransaction,
  } = useAppContext();

  const txId = params.id as string;
  const tx = transactions.find((t) => t.id === txId);

  if (!wallet.connected || !multisig) {
    return (
      <div>
        <Header
          title="Transaction Detail"
          walletAddress={wallet.address}
          connected={wallet.connected}
          isLoading={isLoading}
          auroInstalled={auroInstalled}
          onConnect={connect}
          onDisconnect={disconnect}
        />
        <div className="p-6 text-center py-20">
          <p className="text-safe-text">
            Connect your wallet to view transaction details
          </p>
        </div>
      </div>
    );
  }

  if (!tx) {
    return (
      <div>
        <Header
          title="Transaction Detail"
          walletAddress={wallet.address}
          connected={wallet.connected}
          isLoading={isLoading}
          auroInstalled={auroInstalled}
          onConnect={connect}
          onDisconnect={disconnect}
        />
        <div className="p-6 text-center py-20">
          <p className="text-safe-text">Transaction not found</p>
          <button
            onClick={() => router.push('/transactions')}
            className="mt-4 text-sm text-safe-green hover:underline"
          >
            Back to transactions
          </button>
        </div>
      </div>
    );
  }

  const isOwner = multisig.owners.includes(wallet.address ?? '');
  const hasApproved = tx.approvals.includes(wallet.address ?? '');
  const thresholdMet = tx.approvals.length >= multisig.threshold;
  const canApprove =
    isOwner && !hasApproved && tx.status === 'pending';
  const canExecute = thresholdMet && tx.status === 'pending';

  const handleApprove = async () => {
    if (!wallet.address) return;
    // In production: sign with Auro Wallet and submit approval proof
    updateTransaction(tx.id, {
      approvals: [...tx.approvals, wallet.address],
    });
  };

  const handleExecute = async () => {
    // In production: generate execution proof and submit
    updateTransaction(tx.id, {
      status: 'executed',
      executedAt: Date.now(),
    });
  };

  const statusColors = {
    pending: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    executed: 'text-safe-green bg-safe-green/10 border-safe-green/20',
    failed: 'text-red-400 bg-red-400/10 border-red-400/20',
  };

  return (
    <div>
      <Header
        title={`Transaction #${tx.id}`}
        subtitle={TX_TYPE_LABELS[tx.txType]}
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6 max-w-3xl space-y-6">
        {/* Status banner */}
        <div
          className={`rounded-xl border p-4 ${statusColors[tx.status]}`}
        >
          <div className="flex items-center gap-2">
            {tx.status === 'executed' ? (
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            ) : tx.status === 'pending' ? (
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            ) : (
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            )}
            <span className="font-semibold capitalize">{tx.status}</span>
            {tx.status === 'pending' && (
              <span className="text-sm opacity-75 ml-2">
                — Needs {multisig.threshold - tx.approvals.length} more
                confirmation{multisig.threshold - tx.approvals.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Details Card */}
        <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">
            Details
          </h3>

          <div className="space-y-3">
            <DetailRow label="Type" value={TX_TYPE_LABELS[tx.txType]} />
            <DetailRow label="Nonce" value={`#${tx.nonce}`} />
            <DetailRow
              label="Proposed by"
              value={truncateAddress(tx.proposer)}
              mono
            />

            {tx.txType === 'transfer' && (
              <>
                <DetailRow
                  label="Recipient"
                  value={truncateAddress(tx.to, 10)}
                  mono
                />
                <DetailRow
                  label="Amount"
                  value={`${formatMina(tx.amount)} MINA`}
                />
              </>
            )}

            {tx.txType === 'changeThreshold' && (
              <DetailRow
                label="New Threshold"
                value={`${tx.data} of ${multisig.numOwners}`}
              />
            )}

            {tx.txType === 'addOwner' && (
              <DetailRow
                label="New Owner"
                value={truncateAddress(tx.data, 10)}
                mono
              />
            )}

            {tx.txType === 'removeOwner' && (
              <DetailRow
                label="Remove Owner"
                value={truncateAddress(tx.data, 10)}
                mono
              />
            )}

            <DetailRow
              label="Created"
              value={new Date(tx.createdAt).toLocaleString()}
            />
            {tx.executedAt && (
              <DetailRow
                label="Executed"
                value={new Date(tx.executedAt).toLocaleString()}
              />
            )}
          </div>
        </div>

        {/* Approvals Card */}
        <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">
            Confirmations
          </h3>
          <ApprovalProgress
            approvals={tx.approvals}
            threshold={multisig.threshold}
            owners={multisig.owners}
          />
        </div>

        {/* Action buttons */}
        {tx.status === 'pending' && (
          <div className="flex gap-3">
            {canApprove && (
              <button
                onClick={handleApprove}
                className="flex-1 bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all"
              >
                Confirm Transaction
              </button>
            )}
            {canExecute && (
              <button
                onClick={handleExecute}
                className="flex-1 bg-blue-500 text-white font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all"
              >
                Execute Transaction
              </button>
            )}
            {!isOwner && !canExecute && (
              <p className="text-sm text-safe-text">
                You are not an owner of this wallet.
              </p>
            )}
            {isOwner && hasApproved && !canExecute && (
              <p className="text-sm text-safe-text">
                You have already confirmed. Waiting for other owners.
              </p>
            )}
          </div>
        )}

        {/* Back button */}
        <button
          onClick={() => router.push('/transactions')}
          className="text-sm text-safe-text hover:text-white transition-colors"
        >
          &larr; Back to transactions
        </button>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-safe-border/50 last:border-0">
      <span className="text-sm text-safe-text">{label}</span>
      <span
        className={`text-sm ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
