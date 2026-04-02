'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { submitOffchainSignature, executeBatchTx, assertLedgerReady } from '@/lib/multisigClient';

/** Proposal detail page with approve/execute actions and lifecycle status. */
export default function TransactionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const {
    wallet,
    multisig,
    owners,
    proposals,
    proposalsAddress,
    connect,
    connectAuro,
    connectLedger,
    disconnect,
    isLoading,
    auroInstalled,
    ledgerSupported,
    setWalletNetwork,
    startOperation,
    isOperating,
  } = useAppContext();

  const proposalHash = params.id as string;
  const proposal = proposals.find((item) => item.proposalHash === proposalHash);

  const [approvalAddresses, setApprovalAddresses] = useState<string[]>([]);

  // If the selected contract changes, leave the detail page immediately
  useEffect(() => {
    if (!multisig) return;
    // Contract switched — go to proposals list immediately
    if (proposalsAddress !== null && proposalsAddress !== multisig.address) {
      router.push('/transactions');
      return;
    }
  }, [multisig, proposals, proposal, proposalsAddress, router]);

  useEffect(() => {
    if (!multisig || !proposal) return;
    // Don't fetch until proposals have been loaded for the current contract
    if (proposalsAddress !== multisig.address) return;
    (async () => {
      const rows = await fetchApprovals(multisig.address, proposalHash);
      setApprovalAddresses(rows.map((row) => row.approver));
    })();
  }, [multisig, proposal, proposalHash, proposalsAddress]);

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

  /** Signs the proposal hash offchain and submits to the backend. */
  const handleApprove = async () => {
    if (!proposal || !multisig || !wallet.address) return;

    const captured = { contractAddress: multisig.address, signerAddress: wallet.address, proposalHash: proposal.proposalHash };
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    await startOperation('Signing proposal...', async (onProgress) => {
      return await submitOffchainSignature({
        contractAddress: captured.contractAddress,
        signerAddress: captured.signerAddress,
        proposalHash: captured.proposalHash,
      }, onProgress, signer);
    });
    router.push('/transactions');
  };

  /** Fetches batch payload and submits execute*BatchSig transaction on-chain. */
  const handleExecute = async () => {
    if (!proposal || !multisig || !wallet.address) return;

    const captured = { contractAddress: multisig.address, executorAddress: wallet.address, proposal };
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    try {
      await assertLedgerReady(signer);
    } catch (err) {
      void startOperation('Execute proposal', async () => { throw err; });
      return;
    }
    void startOperation('Building batch execute transaction...', async (onProgress) => {
      return await executeBatchTx({
        contractAddress: captured.contractAddress,
        executorAddress: captured.executorAddress,
        proposal: captured.proposal,
      }, onProgress, signer);
    });
    router.push('/');
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
          ledgerSupported={ledgerSupported}
          walletType={wallet.type}
          onConnect={connect}
          onConnectAuro={connectAuro}
          onConnectLedger={connectLedger}
          onDisconnect={disconnect}
          network={wallet.network}
          onNetworkChange={setWalletNetwork}
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
          ledgerSupported={ledgerSupported}
          walletType={wallet.type}
          onConnect={connect}
          onConnectAuro={connectAuro}
          onConnectLedger={connectLedger}
          onDisconnect={disconnect}
          network={wallet.network}
          onNetworkChange={setWalletNetwork}
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
        ledgerSupported={ledgerSupported}
        walletType={wallet.type}
        onConnect={connect}
        onConnectAuro={connectAuro}
        onConnectLedger={connectLedger}
        onDisconnect={disconnect}
        network={wallet.network}
        onNetworkChange={setWalletNetwork}
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
            <DetailRow label="Proposal Hash" value={proposal.proposalHash} mono copyable />
            <DetailRow label="UID" value={proposal.uid ?? '-'} mono copyable />
            <DetailRow label="Proposed by" value={proposal.proposer ?? '-'} mono copyable />
            {proposal.txType === 'transfer' && (
              <>
                <DetailRow label="Recipient" value={proposal.toAddress ?? '-'} mono copyable />
                <DetailRow label="Amount" value={`${formatMina(proposal.amount)} MINA`} />
              </>
            )}
            {proposal.txType === 'changeThreshold' && (
              <DetailRow label="New Threshold" value={proposal.data ?? '-'} />
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

        {proposal.status === 'pending' && (
          <div className="flex gap-3">
            {canApprove && (
              <button
                onClick={handleApprove}
                disabled={isOperating}
                className="flex-1 bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isOperating ? 'Waiting for pending transaction...' : 'Approve Proposal'}
              </button>
            )}
            {canExecute && (
              <button
                onClick={handleExecute}
                disabled={isOperating}
                className="flex-1 border border-safe-green text-safe-green font-semibold rounded-lg py-3 text-sm hover:bg-safe-green/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isOperating ? 'Waiting for pending transaction...' : 'Execute Proposal'}
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
  copyable = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    setShowTooltip(true);
    timerRef.current = setTimeout(() => setShowTooltip(false), 1200);
  };

  const valueClass = `text-sm truncate ${mono ? 'font-mono' : ''}`;

  return (
    <div className="flex justify-between items-center py-2 border-b border-safe-border/50 last:border-0">
      <span className="text-sm text-safe-text shrink-0">{label}</span>
      {copyable ? (
        <div className="relative ml-12 min-w-0">
          <button
            onClick={handleCopy}
            className={`${valueClass} underline decoration-dotted underline-offset-4 decoration-safe-text/30 cursor-pointer hover:opacity-70 transition-opacity w-full text-right`}
          >
            {value}
          </button>
          <div className={`absolute -top-7 left-1/2 -translate-x-1/2 z-50 transition-all duration-200 pointer-events-none ${showTooltip ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}`}>
            <div className="bg-safe-green/70 backdrop-blur-md text-white text-xs font-semibold rounded-lg px-2.5 py-1 shadow-lg whitespace-nowrap">
              Copied!
            </div>
            <svg className="mx-auto -mt-px" width="10" height="6" viewBox="0 0 10 6">
              <path d="M0 0L5 6L10 0Z" className="fill-safe-green/70" />
            </svg>
          </div>
        </div>
      ) : (
        <span className={`${valueClass} ml-12`}>{value}</span>
      )}
    </div>
  );
}
