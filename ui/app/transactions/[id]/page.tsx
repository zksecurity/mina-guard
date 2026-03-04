'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import ApprovalProgress from '@/components/ApprovalProgress';
import {
  TX_TYPE_LABELS,
  truncateAddress,
  formatMina,
} from '@/lib/types';
import { fetchApprovals } from '@/lib/api';
import { createApproveTx, createExecuteTx } from '@/lib/multisigClient';

/** Proposal detail page with approve/execute actions and lifecycle status. */
export default function TransactionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const {
    wallet,
    multisig,
    owners,
    proposals,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    refreshMultisig,
  } = useAppContext();

  const proposalHash = params.id as string;
  const proposal = proposals.find((item) => item.proposalHash === proposalHash);

  const [approvalAddresses, setApprovalAddresses] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    if (!multisig || !proposalHash) return;
    (async () => {
      const rows = await fetchApprovals(multisig.address, proposalHash);
      setApprovalAddresses(rows.map((row) => row.approver));
    })();
  }, [multisig, proposalHash]);

  const isOwner = useMemo(() => {
    return owners.some((owner) => owner.address === wallet.address);
  }, [owners, wallet.address]);

  const hasApproved = useMemo(() => {
    if (!wallet.address) return false;
    return approvalAddresses.includes(wallet.address);
  }, [approvalAddresses, wallet.address]);

  const threshold = multisig?.threshold ?? 0;
  const canApprove = !!proposal && proposal.status === 'pending' && isOwner && !hasApproved;
  const canExecute = !!proposal && proposal.status === 'pending' && proposal.approvalCount >= threshold;

  /** Submits approve transaction for currently viewed proposal hash. */
  const handleApprove = async () => {
    if (!proposal || !multisig || !wallet.address) return;

    setIsActing(true);
    setActionError(null);
    try {
      const txHash = await createApproveTx({
        contractAddress: multisig.address,
        approverAddress: wallet.address,
        proposal,
      });
      if (!txHash) {
        setActionError('Approve transaction failed.');
      }
      await refreshMultisig();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Approve failed');
    } finally {
      setIsActing(false);
    }
  };

  /** Submits execute transaction for selected proposal type and optional extra params. */
  const handleExecute = async () => {
    if (!proposal || !multisig || !wallet.address) return;

    setIsActing(true);
    setActionError(null);

    try {
      let ownerAddress: string | undefined;
      let delegateAddress: string | undefined;

      if ((proposal.txType === 'addOwner' || proposal.txType === 'removeOwner') && !ownerAddress) {
        ownerAddress = window.prompt('Owner address to execute add/remove owner proposal:') ?? undefined;
      }

      if (proposal.txType === 'setDelegate' && proposal.data !== '0') {
        delegateAddress = window.prompt('Delegate address for executeDelegate:') ?? undefined;
      }

      const txHash = await createExecuteTx({
        contractAddress: multisig.address,
        executorAddress: wallet.address,
        proposal,
        overrides: {
          ownerAddress,
          delegateAddress,
        },
      });

      if (!txHash) {
        setActionError('Execute transaction failed.');
      }

      await refreshMultisig();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Execute failed');
    } finally {
      setIsActing(false);
    }
  };

  if (!wallet.connected || !multisig) {
    return (
      <div>
        <Header
          title="Proposal Detail"
          walletAddress={wallet.address}
          connected={wallet.connected}
          isLoading={isLoading}
          auroInstalled={auroInstalled}
          onConnect={connect}
          onDisconnect={disconnect}
        />
        <div className="p-6 text-center py-20">
          <p className="text-safe-text">Connect wallet to view proposal details</p>
        </div>
      </div>
    );
  }

  if (!proposal) {
    return (
      <div>
        <Header
          title="Proposal Detail"
          walletAddress={wallet.address}
          connected={wallet.connected}
          isLoading={isLoading}
          auroInstalled={auroInstalled}
          onConnect={connect}
          onDisconnect={disconnect}
        />
        <div className="p-6 text-center py-20">
          <p className="text-safe-text">Proposal not found</p>
          <button
            onClick={() => router.push('/transactions')}
            className="mt-4 text-sm text-safe-green hover:underline"
          >
            Back to proposals
          </button>
        </div>
      </div>
    );
  }

  const statusColors = {
    pending: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    executed: 'text-safe-green bg-safe-green/10 border-safe-green/20',
    expired: 'text-red-400 bg-red-400/10 border-red-400/20',
  };

  const txLabel = proposal.txType ? TX_TYPE_LABELS[proposal.txType] : 'Unknown';

  return (
    <div>
      <Header
        title={`Proposal ${truncateAddress(proposal.proposalHash, 8)}`}
        subtitle={txLabel}
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6 max-w-3xl space-y-6">
        <div className={`rounded-xl border p-4 ${statusColors[proposal.status]}`}>
          <div className="flex items-center gap-2">
            <span className="font-semibold capitalize">{proposal.status}</span>
            {proposal.status === 'pending' && threshold > proposal.approvalCount && (
              <span className="text-sm opacity-75 ml-2">
                Needs {threshold - proposal.approvalCount} more approvals
              </span>
            )}
          </div>
        </div>

        <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">Details</h3>
          <div className="space-y-3">
            <DetailRow label="Type" value={txLabel} />
            <DetailRow label="Proposal Hash" value={truncateAddress(proposal.proposalHash, 12)} mono />
            <DetailRow label="Nonce" value={proposal.nonce ?? '-'} mono />
            <DetailRow label="Proposed by" value={proposal.proposer ? truncateAddress(proposal.proposer, 10) : '-'} mono />
            {proposal.txType === 'transfer' && (
              <>
                <DetailRow label="Recipient" value={proposal.toAddress ? truncateAddress(proposal.toAddress, 10) : '-'} mono />
                <DetailRow label="Amount" value={`${formatMina(proposal.amount)} MINA`} />
              </>
            )}
            <DetailRow label="Config Nonce" value={proposal.configNonce ?? '-'} mono />
            <DetailRow label="Expiry Block" value={proposal.expiryBlock ?? '0'} mono />
            <DetailRow label="Created" value={new Date(proposal.createdAt).toLocaleString()} />
          </div>
        </div>

        <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">Confirmations</h3>
          <ApprovalProgress
            approvalCount={proposal.approvalCount}
            threshold={threshold}
            owners={owners.map((owner) => owner.address)}
            approvalAddresses={approvalAddresses}
          />
        </div>

        {actionError && <p className="text-sm text-red-400">{actionError}</p>}

        {proposal.status === 'pending' && (
          <div className="flex gap-3">
            {canApprove && (
              <button
                onClick={handleApprove}
                disabled={isActing}
                className="flex-1 bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-60"
              >
                {isActing ? 'Submitting...' : 'Approve Proposal'}
              </button>
            )}
            {canExecute && (
              <button
                onClick={handleExecute}
                disabled={isActing}
                className="flex-1 bg-blue-500 text-white font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-60"
              >
                {isActing ? 'Submitting...' : 'Execute Proposal'}
              </button>
            )}
          </div>
        )}

        <button
          onClick={() => router.push('/transactions')}
          className="text-sm text-safe-text hover:text-white transition-colors"
        >
          &larr; Back to proposals
        </button>
      </div>
    </div>
  );
}

/** Label-value row primitive used in details cards. */
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
      <span className={`text-sm ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
