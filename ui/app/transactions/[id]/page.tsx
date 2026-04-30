'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import ApprovalProgress from '@/components/ApprovalProgress';
import MemoWarningTooltip from '@/components/MemoWarningTooltip';
import {
  TX_TYPE_LABELS,
  formatMina,
  isDeleteProposal,
  truncateAddress,
  type Proposal,
} from '@/lib/types';
import { fetchApprovals, extractTxHash, fetchBalance, recordSubmission } from '@/lib/api';
import {
  approveProposalOnchain,
  executeProposalOnchain,
  executeChildLifecycleOnchain,
  executeSetupChildOnchain,
  assertLedgerReady,
} from '@/lib/multisigClient';
import { fetchChildConfigFromEvents } from '@/lib/api';
import {
  PENDING_TXS_CHANGED,
  getPendingTx,
  savePendingTx,
} from '@/lib/storage';
import { useContractTxLock } from '@/hooks/useContractTxLock';
import { assertValidMinaAddress, buildOfflineApproveBundle, buildOfflineExecuteBundle } from '@/lib/offline-signing';
import { DownloadCLILink, OfflineSigningFlow, UploadSignedResponse } from '@/components/OfflineSigningFlow';

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
    indexerStatus,
    startOperation,
    isOperating,
  } = useAppContext();

  const proposalHash = params.id as string;
  const proposal = proposals.find((item) => item.proposalHash === proposalHash);

  const [approvalAddresses, setApprovalAddresses] = useState<string[]>([]);
  const [actionMode, setActionMode] = useState<'online' | 'offline'>('online');
  const [offlineFeePayerAddress, setOfflineFeePayerAddress] = useState('');
  const [exportedBundleName, setExportedBundleName] = useState<string | null>(null);
  const [cliBinaryName, setCliBinaryName] = useState<string | null>(null);

  // Per-signer approve self-disable: did *this* wallet submit an approval
  // that's still in flight for this proposal? Watched via PENDING_TXS_CHANGED
  // so the button toggles the moment the user clicks Approve.
  const [myPendingApprove, setMyPendingApprove] = useState<{ txHash: string } | null>(null);
  const refreshMyPendingApprove = useCallback(() => {
    if (!multisig || !wallet.address) {
      setMyPendingApprove(null);
      return;
    }
    const pt = getPendingTx(multisig.address, proposalHash, 'approve', wallet.address);
    setMyPendingApprove(pt ? { txHash: pt.txHash } : null);
  }, [multisig, wallet.address, proposalHash]);

  useEffect(() => {
    refreshMyPendingApprove();
    const handler = () => refreshMyPendingApprove();
    window.addEventListener(PENDING_TXS_CHANGED, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(PENDING_TXS_CHANGED, handler);
      window.removeEventListener('storage', handler);
    };
  }, [refreshMyPendingApprove]);

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
    if (proposal._localPending) return;
    // Don't fetch until proposals have been loaded for the current contract
    if (proposalsAddress !== multisig.address) return;
    let cancelled = false;
    (async () => {
      const rows = await fetchApprovals(multisig.address, proposalHash);
      if (!cancelled) setApprovalAddresses(rows.map((row) => row.approver));
    })();
    return () => { cancelled = true; };
  }, [multisig, proposal, proposalHash, proposalsAddress]);

  const isOwner = useMemo(() => {
    return owners.some((owner) => owner.address === wallet.address);
  }, [owners, wallet.address]);

  const hasApproved = useMemo(() => {
    if (!wallet.address) return false;
    return approvalAddresses.includes(wallet.address);
  }, [approvalAddresses, wallet.address]);

  // Source Vault/SubVault that funds the proposal's outgoing MINA. For
  // transfer/allocateChild it's the Vault we're viewing; for reclaimChild it's
  // the SubVault being drained.
  const spendingTarget = useMemo(
    () => (proposal && multisig ? getSpendingTarget(proposal, multisig.address) : null),
    [proposal, multisig?.address],
  );
  const [sourceBalance, setSourceBalance] = useState<string | null>(null);
  const [balanceFetchFailed, setBalanceFetchFailed] = useState(false);
  useEffect(() => {
    if (!spendingTarget) {
      setSourceBalance(null);
      setBalanceFetchFailed(false);
      return;
    }
    let cancelled = false;
    fetchBalance(spendingTarget.sourceAddress)
      .then((b) => {
        if (cancelled) return;
        setSourceBalance(b);
        setBalanceFetchFailed(b === null);
      })
      .catch(() => {
        if (cancelled) return;
        setSourceBalance(null);
        setBalanceFetchFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [spendingTarget?.sourceAddress, indexerStatus?.lastSuccessfulRunAt]);
  // Fail-open on unknown balance (sourceBalance === null): the backend
  // returns null when the daemon doesn't see the account yet, and we don't
  // want to silently hide Execute in that window. A real "0" from the daemon
  // (Vault exists, empty) gates execution.
  const insufficientBalance =
    spendingTarget != null &&
    sourceBalance != null &&
    !balanceFetchFailed &&
    BigInt(sourceBalance) < spendingTarget.amount;

  const threshold = multisig?.threshold ?? 0;
  const isConfigStale =
    !!proposal &&
    proposal.status === 'pending' &&
    proposal.configNonce != null &&
    multisig?.configNonce != null &&
    proposal.configNonce !== String(multisig.configNonce);
  const isLocalPending = proposal?._localPending === true;
  // Cross-signer execute lock: while ANY signer's execute tx is in flight
  // (server's lastExecuteTxHash is set and no failure has been recorded), the
  // Execute button is disabled for everyone — re-executing now would just
  // burn fee on a guaranteed on-chain failure.
  const executeInFlight =
    !!proposal &&
    !proposal._localPending &&
    proposal.status === 'pending' &&
    proposal.lastExecuteTxHash != null &&
    proposal.lastExecuteError == null;
  // Contract-wide indexer-lag lock. Any in-flight tx on this contract (own
  // or cross-signer) makes rebuildStoresFromBackend stale; serialize until
  // the indexer catches up.
  //
  // Exception: the viewed proposal's own *already-counted* approve. Approval
  // counts are event-sourced from the indexer (see applyApprovalEvent), so
  // `approvalCount >= threshold` proves the chain's approvalRoot reflects
  // those approvals and is fresh enough to execute. The lingering
  // `lastApproveTxHash` on the same record is just stale metadata when the
  // indexer's tx-hash-match clearing doesn't fire (e.g. archive vs broadcast
  // hash format mismatches). Mask that signal so it doesn't gate execute on
  // this page.
  const proposalsForLock = useMemo(
    () =>
      proposals.map((p) => {
        const isViewedAndCounted =
          proposal != null &&
          p.proposalHash === proposal.proposalHash &&
          p.lastApproveTxHash != null &&
          p.lastApproveError == null &&
          p.approvalCount >= threshold;
        return isViewedAndCounted ? { ...p, lastApproveTxHash: null } : p;
      }),
    [proposals, proposal?.proposalHash, threshold],
  );
  const contractLock = useContractTxLock(multisig?.address ?? null, proposalsForLock);
  const canApprove =
    !!proposal &&
    !isLocalPending &&
    proposal.status === 'pending' &&
    isOwner &&
    !hasApproved &&
    !isConfigStale &&
    !myPendingApprove &&
    !contractLock.locked;
  const canExecute =
    !!proposal &&
    !isLocalPending &&
    proposal.status === 'pending' &&
    proposal.approvalCount >= threshold &&
    !isConfigStale &&
    !executeInFlight &&
    !contractLock.locked &&
    !insufficientBalance;
  const canDelete =
    !!proposal &&
    !isLocalPending &&
    proposal.status === 'pending' &&
    isOwner &&
    proposal.nonce !== null &&
    !isDeleteProposal(proposal) &&
    // CREATE_CHILD uses the reserved nonce=0 sentinel, which the current
    // delete mechanism (zero-value proposal at same nonce) can't replicate
    // safely.
    proposal.txType !== 'createChild' &&
    // While an execute is in flight, the proposal is about to be invalidated
    // either way (success → executed, failure → user retries). Surfacing
    // Delete here just invites duplicate work / wasted fees.
    !executeInFlight &&
    !contractLock.locked;
  const isNonceStale = proposal?.status === 'invalidated' && proposal.invalidReason === 'proposal_nonce_stale';

  /** Submits an on-chain approveProposal transaction. */
  const handleApprove = async () => {
    if (!proposal || !multisig || !wallet.address) return;

    const captured = { contractAddress: multisig.address, approverAddress: wallet.address, proposal };
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    try {
      await assertLedgerReady(signer);
    } catch (err) {
      void startOperation('Approve proposal', async () => { throw err; });
      return;
    }
    let success = false;
    await startOperation('Submitting approval on-chain...', async (onProgress) => {
      const result = await approveProposalOnchain({
        contractAddress: captured.contractAddress,
        approverAddress: captured.approverAddress,
        proposal: captured.proposal,
      }, onProgress, signer);
      const txHash = extractTxHash(result);
      if (txHash) {
        await recordSubmission(captured.contractAddress, captured.proposal.proposalHash, 'approve', txHash);
        savePendingTx({
          kind: 'approve',
          contractAddress: captured.contractAddress,
          proposalHash: captured.proposal.proposalHash,
          txHash,
          signerPubkey: captured.approverAddress,
          createdAt: new Date().toISOString(),
        });
      }
      if (result) success = true;
      return result;
    });
    if (success) router.push('/transactions');
  };

  /** Submits the appropriate single-sig execute* transaction on-chain. */
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
    let success = false;
    await startOperation('Building execute transaction...', async (onProgress) => {
      const isCreateChild = captured.proposal.txType === 'createChild';
      const isRemoteLifecycle =
        captured.proposal.destination === 'remote' &&
        captured.proposal.childAccount &&
        (captured.proposal.txType === 'reclaimChild' ||
          captured.proposal.txType === 'destroyChild' ||
          captured.proposal.txType === 'enableChildMultiSig');

      const finalize = (result: string | null) => {
        const txHash = extractTxHash(result);
        if (txHash) {
          void recordSubmission(captured.contractAddress, captured.proposal.proposalHash, 'execute', txHash);
          savePendingTx({
            kind: 'execute',
            contractAddress: captured.contractAddress,
            proposalHash: captured.proposal.proposalHash,
            txHash,
            signerPubkey: captured.executorAddress,
            createdAt: new Date().toISOString(),
          });
        }
        if (result) success = true;
        return result;
      };

      if (isCreateChild) {
        onProgress('Fetching child config from events...');
        const childConfig = await fetchChildConfigFromEvents(
          captured.contractAddress,
          captured.proposal.proposalHash,
        );
        if (!childConfig) throw new Error('Child config not found in indexed events');
        const result = await executeSetupChildOnchain({
          parentAddress: captured.contractAddress,
          childAddress: captured.proposal.childAccount!,
          executorAddress: captured.executorAddress,
          childOwners: childConfig.owners,
          childThreshold: childConfig.threshold,
          proposal: captured.proposal,
        }, onProgress, signer);
        return finalize(result);
      }

      if (isRemoteLifecycle) {
        const result = await executeChildLifecycleOnchain({
          childAddress: captured.proposal.childAccount!,
          parentAddress: captured.contractAddress,
          executorAddress: captured.executorAddress,
          proposal: captured.proposal,
        }, onProgress, signer);
        return finalize(result);
      }

      const result = await executeProposalOnchain({
        contractAddress: captured.contractAddress,
        executorAddress: captured.executorAddress,
        proposal: captured.proposal,
      }, onProgress, signer);
      return finalize(result);
    });
    if (success) router.push(`/accounts/${captured.contractAddress}`);
  };

  const handleDelete = () => {
    if (!proposal?.nonce) return;

    // The form recomputes `effectiveTxType` from the target's destination, so
    // the `type` URL param here is informational only. We pick `transfer` as
    // the neutral default (matches the LOCAL-delete shape).
    const params = new URLSearchParams({
      mode: 'delete',
      type: 'transfer',
      targetProposalHash: proposal.proposalHash,
      targetNonce: proposal.nonce,
    });
    router.push(`/transactions/new?${params.toString()}`);
  };

  if (!wallet.connected || !multisig) {
    return (
      <div>
        <div className="p-6 text-center py-20">
          <p className="text-safe-text">Connect wallet to view proposal details</p>
        </div>
      </div>
    );
  }

  if (!proposal) {
    const hasPendingCreate = !!getPendingTx(multisig.address, proposalHash, 'create');
    const stillLoading = proposalsAddress !== multisig.address || hasPendingCreate;
    return (
      <div>
        <div className="p-6 text-center py-20">
          {stillLoading ? (
            <p className="text-safe-text/60">Loading…</p>
          ) : (
            <>
              <p className="text-safe-text">Proposal not found</p>
              <button
                onClick={() => router.push('/transactions')}
                className="mt-4 text-sm text-safe-green hover:underline"
              >
                Back to proposals
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const statusColors = {
    pending: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    executed: 'text-safe-green bg-safe-green/10 border-safe-green/20',
    expired: 'text-red-400 bg-red-400/10 border-red-400/20',
    invalidated: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  };

  const txLabel = isDeleteProposal(proposal)
    ? 'Delete proposal'
    : proposal.txType ? TX_TYPE_LABELS[proposal.txType] : 'Unknown';

  const hasMemo = proposal.memoHash != null && proposal.memoHash !== '0';
  const isExecuted = proposal.status === 'executed';
  const memoAdornment: ReactNode | undefined = (() => {
    if (!hasMemo) return undefined;
    if (isExecuted) {
      const allMatch = proposal.proposalMemoMatch === true && proposal.memoExecutionMatch === true;
      if (allMatch) return <MemoWarningTooltip variant="match" />;
      return <MemoWarningTooltip variant="mismatch" />;
    }
    if (proposal.proposalMemoMatch === false) return <MemoWarningTooltip variant="proposalMismatch" />;
    return undefined;
  })();

  const isRemote = proposal.destination === 'remote';
  const isDelete = isDeleteProposal(proposal);
  const headerSubline = isDelete
    ? proposal.nonce != null
      ? `Invalidates proposal with nonce #${proposal.nonce}`
      : 'Invalidates another proposal'
    : isRemote
      ? proposal.childAccount
        ? `Executes on SubVault ${truncateAddress(proposal.childAccount)}`
        : 'Executes on SubVault'
      : 'Executes on this Vault';

  // Pull the pending-create entry directly so we can show its tx hash even
  // before the synthesized row carries it via `proposal.lastExecuteTxHash`.
  const localPendingCreateTxHash = isLocalPending
    ? getPendingTx(multisig.address, proposalHash, 'create')?.txHash
    : null;

  return (
    <div>
      <div className="p-6 max-w-3xl space-y-6">
        <button
          onClick={() => router.push('/transactions')}
          className="flex items-center gap-1.5 text-sm text-safe-text/60 hover:text-safe-text transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to proposals
        </button>
        <div className={`rounded-xl border p-4 ${statusColors[proposal.status]}`}>
          <div className="flex items-center gap-2">
            <span className="font-semibold capitalize">{proposal.status}</span>
            {proposal.status === 'pending' && !isConfigStale && !isLocalPending && threshold > proposal.approvalCount && (
              <span className="text-sm opacity-75 ml-2">
                Needs {threshold - proposal.approvalCount} more approvals
              </span>
            )}
          </div>
          <p className="text-xs opacity-75 mt-1">{headerSubline}</p>
        </div>

        {isLocalPending && (
          <PendingTxBanner
            tone="creation"
            title="Submitted — awaiting inclusion"
            description="Your proposal was broadcast to the network. It should appear here once the next block is produced (~3 min)."
            txHash={localPendingCreateTxHash ?? null}
            network={wallet.network ?? null}
          />
        )}

        {executeInFlight && proposal.lastExecuteTxHash && (
          <PendingTxBanner
            tone="execution"
            title="Execution in progress"
            description="Another signer broadcast an execute transaction. New executes will fail on-chain until it lands or fails — buttons are disabled."
            txHash={proposal.lastExecuteTxHash}
            network={wallet.network ?? null}
          />
        )}

        {myPendingApprove && (
          <PendingTxBanner
            tone="approval"
            title="Your approval is in flight"
            description="Waiting for the network to include your approval transaction."
            txHash={myPendingApprove.txHash}
            network={wallet.network ?? null}
          />
        )}

        {contractLock.locked && !executeInFlight && !myPendingApprove && (
          <PendingTxBanner
            tone="approval"
            title="Indexer catching up"
            description={`${contractLock.reason} New submissions on this contract are blocked until it lands (~3 min).`}
            txHash={contractLock.txHash}
            network={wallet.network ?? null}
          />
        )}

        {isConfigStale && (
          <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-red-400 text-sm">
            <p className="font-semibold mb-1">Outdated config nonce</p>
            <p className="opacity-90">
              This proposal was created under config nonce {proposal.configNonce}, but the contract is now
              at {multisig?.configNonce}. It can no longer be executed — governance changed since this
              proposal was made. Create a new proposal to proceed.
            </p>
          </div>
        )}

        {isNonceStale && (
          <div className="rounded-xl border border-orange-400/30 bg-orange-400/10 p-4 text-orange-300 text-sm">
            <p className="font-semibold mb-1">Proposal invalidated by a later nonce</p>
            <p className="opacity-90">
              Another proposal in the same execution order was executed first, so this proposal can no longer be
              approved or executed. Create a new proposal with a fresh nonce to proceed.
            </p>
          </div>
        )}

        <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">Details</h3>
          <div className="space-y-3">
            <DetailRow label="Type" value={txLabel} />
            <DetailRow label="Proposal Hash" value={proposal.proposalHash} mono copyable />
            <DetailRow label="Nonce" value={proposal.nonce ?? '-'} mono copyable />
            <DetailRow label="Proposed by" value={proposal.proposer ?? '-'} mono copyable />
            {proposal.txType === 'transfer' && !isDeleteProposal(proposal) && (
              <>
                <DetailRow label="Recipients" value={String(proposal.recipientCount)} />
                <DetailRow label="Total Amount" value={`${formatMina(proposal.totalAmount)} MINA`} />
              </>
            )}
            {proposal.txType === 'changeThreshold' && (
              <DetailRow label="New Threshold" value={proposal.data ?? '-'} />
            )}
            {proposal.txType === 'addOwner' && (
              <DetailRow label="Owner to Add" value={proposal.toAddress ?? '-'} mono copyable />
            )}
            {proposal.txType === 'removeOwner' && (
              <DetailRow label="Owner to Remove" value={proposal.toAddress ?? '-'} mono copyable />
            )}
            {proposal.txType === 'setDelegate' && (
              <DetailRow
                label="Delegate"
                value={proposal.toAddress ?? '(undelegate)'}
                mono={!!proposal.toAddress}
                copyable={!!proposal.toAddress}
              />
            )}
            <DetailRow label="Config Nonce" value={proposal.configNonce ?? '-'} mono />
            <DetailRow label="Expiry Slot" value={proposal.expirySlot ?? '0'} mono />
            {hasMemo && (
              <DetailRow label="Memo" value={proposal.memo ?? proposal.memoHash!} mono={!proposal.memo} labelAdornment={memoAdornment} />
            )}
            <DetailRow label="Created" value={new Date(proposal.createdAt).toLocaleString()} />
          </div>
        </div>

        {proposal.txType === 'transfer' && proposal.receivers.length > 0 && (
          <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">Recipients</h3>
            <div className="space-y-2">
              {proposal.receivers.map((receiver) => (
                <div
                  key={`${receiver.index}-${receiver.address}-${receiver.amount}`}
                  className="flex items-center justify-between gap-4 rounded-lg border border-safe-border/60 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-safe-text">Recipient #{receiver.index + 1}</p>
                    <p className="text-sm font-mono truncate">{receiver.address}</p>
                  </div>
                  <p className="text-sm font-mono text-safe-green shrink-0">
                    {formatMina(receiver.amount)} MINA
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {!isLocalPending && (
          <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-safe-text uppercase tracking-wider">Confirmations</h3>
            <ApprovalProgress
              approvalCount={proposal.approvalCount}
              threshold={threshold}
              owners={owners.map((owner) => owner.address)}
              approvalAddresses={approvalAddresses}
              status={proposal.status}
            />
          </div>
        )}

        {proposal.status === 'pending' && (proposal.lastExecuteError || proposal.lastApproveError) && (
          <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-red-300 text-sm space-y-1">
            <p className="font-semibold">Last attempt failed</p>
            {proposal.lastExecuteError && (
              <p className="opacity-90 break-words">Execute: {proposal.lastExecuteError}</p>
            )}
            {proposal.lastApproveError && (
              <p className="opacity-90 break-words">Approve: {proposal.lastApproveError}</p>
            )}
            <p className="opacity-75 text-xs pt-1">Use the button below to retry.</p>
          </div>
        )}

        {insufficientBalance && proposal.approvalCount >= threshold && (
          <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-red-300 text-sm">
            <p className="font-semibold mb-1">Insufficient balance</p>
            <p className="opacity-90">
              The {proposal.txType === 'reclaimChild' ? 'SubVault' : 'Vault'} holds{' '}
              {formatMina(sourceBalance!)} MINA but this proposal sends{' '}
              {formatMina(spendingTarget!.amount.toString())} MINA. Execute is
              blocked until it is funded.
            </p>
          </div>
        )}

        {proposal.status === 'pending' && !isLocalPending && (
          <div className="bg-safe-gray border border-safe-border rounded-xl overflow-hidden">
            <div className="flex border-b border-safe-border">
              <button
                type="button"
                onClick={() => setActionMode('online')}
                className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                  actionMode === 'online'
                    ? 'text-safe-green border-b-2 border-safe-green'
                    : 'text-safe-text/60 hover:text-safe-text'
                }`}
              >
                Online
              </button>
              <button
                type="button"
                onClick={() => setActionMode('offline')}
                className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                  actionMode === 'offline'
                    ? 'text-safe-green border-b-2 border-safe-green'
                    : 'text-safe-text/60 hover:text-safe-text'
                }`}
              >
                Offline
              </button>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-xs text-safe-text/60">
                {actionMode === 'online'
                  ? 'Sign and broadcast directly from your browser wallet or Ledger.'
                  : 'Export a bundle, sign on an air-gapped machine, then upload the signed transaction to broadcast.'}
              </p>
              {actionMode === 'online' ? (
                <div className="flex gap-3 flex-wrap">
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
                  {canDelete && (
                    <button
                      onClick={handleDelete}
                      disabled={isOperating}
                      className="flex-1 border border-orange-400/50 text-orange-300 font-semibold rounded-lg py-3 text-sm hover:bg-orange-400/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isOperating ? 'Waiting for pending transaction...' : 'Delete Proposal'}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-sm text-safe-text font-medium">Signer Address (Fee Payer)</label>
                    <input
                      type="text"
                      value={offlineFeePayerAddress}
                      onChange={(e) => setOfflineFeePayerAddress(e.target.value)}
                      placeholder="B62q..."
                      className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
                    />
                    <p className="text-xs text-amber-400">This must be the public key corresponding to the MINA_PRIVATE_KEY used on the air-gapped machine.</p>
                  </div>
                  <DownloadCLILink exportedBundleName={exportedBundleName} onPlatformSelect={setCliBinaryName} />
                  <div className="flex flex-wrap gap-3">
                    {proposal.approvalCount < owners.length && (
                      <OfflineSigningFlow
                        action="approve"
                        label="Approve"
                        onExported={setExportedBundleName}
                        cliBinaryName={cliBinaryName}
                        onBuildBundle={() => {
                          assertValidMinaAddress(offlineFeePayerAddress);
                          if (!owners.some((o) => o.address === offlineFeePayerAddress)) {
                            throw new Error('Signer address is not an owner of this multisig');
                          }
                          if (approvalAddresses.includes(offlineFeePayerAddress)) {
                            throw new Error('This address has already approved this proposal');
                          }
                          const p = proposal!;
                          return buildOfflineApproveBundle({
                            contractAddress: multisig!.address,
                            feePayerAddress: offlineFeePayerAddress,
                            proposal: { ...p, receivers: p.receivers.map((r) => ({ address: r.address, amount: r.amount })) },
                          });
                        }}
                      />
                    )}
                    {proposal.approvalCount >= threshold && (
                      <OfflineSigningFlow
                        action="execute"
                        label="Execute"
                        onExported={setExportedBundleName}
                        cliBinaryName={cliBinaryName}
                        onBuildBundle={() => {
                          assertValidMinaAddress(offlineFeePayerAddress);
                          const p = proposal!;
                          return buildOfflineExecuteBundle({
                            contractAddress: multisig!.address,
                            feePayerAddress: offlineFeePayerAddress,
                            proposal: { ...p, receivers: p.receivers.map((r) => ({ address: r.address, amount: r.amount })) },
                          });
                        }}
                      />
                    )}
                  </div>
                  <UploadSignedResponse
                    acceptActions={proposal.approvalCount >= threshold ? ['approve', 'execute'] : ['approve']}
                    onComplete={(response, txHash) => {
                      const kind = response.action as 'approve' | 'execute';
                      void recordSubmission(multisig!.address, proposal!.proposalHash, kind, txHash);
                      savePendingTx({
                        kind,
                        contractAddress: multisig!.address,
                        proposalHash: proposal!.proposalHash,
                        txHash,
                        signerPubkey: offlineFeePayerAddress,
                        createdAt: new Date().toISOString(),
                      });
                      if (kind === 'execute') {
                        router.push(`/accounts/${multisig!.address}`);
                      } else {
                        router.push('/transactions');
                      }
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

/** Inline banner for a tx that's been broadcast but not yet on-chain.
 *  The tx hash links to NEXT_PUBLIC_BLOCK_EXPLORER_URL — same pattern used
 *  by the global "Transaction submitted" toast in `app/layout.tsx`. */
function PendingTxBanner({
  tone,
  title,
  description,
  txHash,
  network,
}: {
  tone: 'creation' | 'approval' | 'execution';
  title: string;
  description: string;
  txHash: string | null;
  network: string | null;
}) {
  const palette = tone === 'execution'
    ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
    : tone === 'approval'
      ? 'border-sky-400/30 bg-sky-400/10 text-sky-200'
      : 'border-yellow-400/30 bg-yellow-400/10 text-yellow-200';
  const explorerUrl = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? '';
  const truncated = txHash ? truncateAddress(txHash, 8) : null;
  return (
    <div className={`rounded-xl border p-4 text-sm space-y-1 ${palette}`}>
      <p className="font-semibold">{title}</p>
      <p className="opacity-90">{description}</p>
      {txHash && truncated && (
        <p className="text-xs opacity-90 pt-1 font-mono">
          {explorerUrl ? (
            <a
              href={`${explorerUrl}/tx/${txHash}?network=${network ?? ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:opacity-100"
            >
              {truncated}
            </a>
          ) : (
            truncated
          )}
        </p>
      )}
    </div>
  );
}

/** Label-value row primitive used in details cards. */
function DetailRow({
  label,
  value,
  mono = false,
  copyable = false,
  labelAdornment,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
  labelAdornment?: ReactNode;
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
      <span className="flex items-center gap-1 text-sm text-safe-text shrink-0">
        {label}
        {labelAdornment}
      </span>
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

/** Returns the source Vault address and outgoing nanomina amount for proposals
 *  that move MINA out of a Vault, or null if the proposal can't underfund. */
function getSpendingTarget(
  proposal: Proposal,
  contractAddress: string,
): { sourceAddress: string; amount: bigint } | null {
  if (isDeleteProposal(proposal)) return null;
  if (proposal.txType === 'transfer' || proposal.txType === 'allocateChild') {
    if (!proposal.totalAmount) return null;
    return { sourceAddress: contractAddress, amount: BigInt(proposal.totalAmount) };
  }
  if (proposal.txType === 'reclaimChild' && proposal.childAccount && proposal.data) {
    return { sourceAddress: proposal.childAccount, amount: BigInt(proposal.data) };
  }
  return null;
}
