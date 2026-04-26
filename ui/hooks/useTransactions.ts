'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchApprovals, fetchProposals, fetchTxStatus } from '@/lib/api';
import { Proposal } from '@/lib/types';
import {
  PENDING_TXS_CHANGED,
  clearPendingTx,
  getPendingTxsForContract,
  type PendingTx,
} from '@/lib/storage';

/** Wait this long before asking the daemon whether a pending CREATE landed.
 *  Mina blocks are ~3 min, so anything sooner is guaranteed-pending. */
const CREATE_TX_STATUS_PROBE_MIN_AGE_MS = 30_000;

/** Polls backend proposal endpoints for the currently selected contract and
 *  reconciles localStorage `PendingTx` entries against the indexer each tick.
 *  Exposes `proposals` augmented with synthetic rows for not-yet-indexed
 *  create-pending entries so the proposals list and detail page can render
 *  them seamlessly. */
export function useTransactions(multisigAddress: string | null) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsAddress, setProposalsAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingTxs, setPendingTxs] = useState<PendingTx[]>([]);

  const addressRef = useRef(multisigAddress);
  const initialLoadDone = useRef(false);
  const prevApprovalCountByHash = useRef<Map<string, number>>(new Map());
  addressRef.current = multisigAddress;

  /** Reads the latest pending-tx records for the active contract from
   *  localStorage. Called on mount, on storage events, and after each
   *  reconciliation tick that may have cleared entries. */
  const reloadPendingTxs = useCallback(() => {
    if (!multisigAddress) {
      setPendingTxs([]);
      return;
    }
    setPendingTxs(getPendingTxsForContract(multisigAddress));
  }, [multisigAddress]);

  /** Runs after each fresh `rows` fetch. Clears localStorage entries whose
   *  on-chain reality has been observed; for stale create-entries that the
   *  indexer hasn't surfaced, asks the daemon directly so dropped txs don't
   *  linger forever. */
  const reconcilePendingTxs = useCallback(async (
    contractAddress: string,
    rows: Proposal[],
    pending: PendingTx[],
  ) => {
    const indexedByHash = new Map(rows.map((row) => [row.proposalHash, row]));

    // Track approval-count deltas so we only re-fetch the approvals list
    // when something actually changed (avoids hammering the backend).
    const prevCounts = prevApprovalCountByHash.current;
    const currentCounts = new Map(rows.map((row) => [row.proposalHash, row.approvalCount]));

    let dirty = false;

    for (const pt of pending) {
      const indexed = indexedByHash.get(pt.proposalHash);

      if (pt.kind === 'create') {
        // CREATE_CHILD entries need to live until the child *contract* is
        // indexed (Finalize deployment runs the child deploy + setup). The
        // parent's CREATE_CHILD proposal getting indexed is just step 1 — if
        // we cleared here, the Finalize button on PendingSubaccountsBanner
        // would vanish before the user could click it. PendingSubaccountsBanner
        // owns the cleanup for those entries (keyed off the contracts list).
        if (pt.childAccount) continue;

        if (indexed) {
          clearPendingTx(pt.contractAddress, pt.proposalHash, 'create', pt.signerPubkey);
          dirty = true;
          continue;
        }
        // No row yet — only probe the daemon once the entry is old enough
        // to plausibly have failed (otherwise we just spam tx-status).
        const ageMs = Date.now() - new Date(pt.createdAt).getTime();
        if (pt.txHash && ageMs >= CREATE_TX_STATUS_PROBE_MIN_AGE_MS) {
          const status = await fetchTxStatus(pt.txHash);
          if (status?.status === 'failed') {
            clearPendingTx(pt.contractAddress, pt.proposalHash, 'create', pt.signerPubkey);
            dirty = true;
          }
        }
        continue;
      }

      if (pt.kind === 'execute') {
        if (!indexed) continue;
        if (indexed.status === 'executed') {
          clearPendingTx(pt.contractAddress, pt.proposalHash, 'execute', pt.signerPubkey);
          dirty = true;
          continue;
        }
        if (indexed.lastExecuteError && indexed.lastExecuteTxHash === pt.txHash) {
          clearPendingTx(pt.contractAddress, pt.proposalHash, 'execute', pt.signerPubkey);
          dirty = true;
        }
        continue;
      }

      if (pt.kind === 'approve') {
        if (!indexed) continue;
        if (indexed.lastApproveError && indexed.lastApproveTxHash === pt.txHash) {
          clearPendingTx(pt.contractAddress, pt.proposalHash, 'approve', pt.signerPubkey);
          dirty = true;
          continue;
        }
        // Only refetch approvals when the count rose since last tick — the
        // freshly-observed approval might be ours.
        const prev = prevCounts.get(pt.proposalHash) ?? indexed.approvalCount;
        if (indexed.approvalCount > prev) {
          const approvals = await fetchApprovals(contractAddress, pt.proposalHash);
          if (approvals.some((row) => row.approver === pt.signerPubkey)) {
            clearPendingTx(pt.contractAddress, pt.proposalHash, 'approve', pt.signerPubkey);
            dirty = true;
          }
        }
      }
    }

    prevApprovalCountByHash.current = currentCounts;
    if (dirty) reloadPendingTxs();
  }, [reloadPendingTxs]);

  /** Pulls latest proposals for the active contract. */
  const refresh = useCallback(async () => {
    if (!multisigAddress) {
      setProposals([]);
      return;
    }

    if (!initialLoadDone.current) setIsLoading(true);
    try {
      const rows = await fetchProposals(multisigAddress, { limit: 200, offset: 0 });
      // Bail if the address changed while fetching
      if (addressRef.current !== multisigAddress) return;
      setProposals(rows);
      setProposalsAddress(multisigAddress);
      const pending = getPendingTxsForContract(multisigAddress);
      void reconcilePendingTxs(multisigAddress, rows, pending);
    } finally {
      setIsLoading(false);
      initialLoadDone.current = true;
    }
  }, [multisigAddress, reconcilePendingTxs]);

  useEffect(() => {
    // Clear stale proposals immediately so consumers don't mix old data with the new address
    setProposals([]);
    setProposalsAddress(null);
    initialLoadDone.current = false;
    prevApprovalCountByHash.current = new Map();
    reloadPendingTxs();
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS) || 10_000);

    return () => clearInterval(interval);
  }, [refresh, reloadPendingTxs]);

  // Cross-tab sync: localStorage `storage` events fire across tabs;
  // PENDING_TXS_CHANGED fires within the same tab on save/clear.
  useEffect(() => {
    const handler = () => reloadPendingTxs();
    window.addEventListener(PENDING_TXS_CHANGED, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(PENDING_TXS_CHANGED, handler);
      window.removeEventListener('storage', handler);
    };
  }, [reloadPendingTxs]);

  /** Server proposals plus synthetic rows for create-pending entries that
   *  the indexer hasn't yet surfaced. Real rows always win on hash collision. */
  const proposalsWithPending = useMemo<Proposal[]>(() => {
    if (pendingTxs.length === 0) return proposals;
    const knownHashes = new Set(proposals.map((p) => p.proposalHash));
    const synthetic: Proposal[] = pendingTxs
      .filter((pt) => pt.kind === 'create' && !knownHashes.has(pt.proposalHash))
      .map((pt) => synthesizePendingProposal(pt));
    if (synthetic.length === 0) return proposals;
    // Newest-first to match how the backend sorts proposals.
    return [...synthetic, ...proposals];
  }, [proposals, pendingTxs]);

  const pendingCount = proposalsWithPending.filter((p) => p.status === 'pending').length;

  return {
    proposals: proposalsWithPending,
    /** Server-only proposals, without any synthetic local-create rows.
     *  Useful when callers explicitly need indexer-confirmed data. */
    serverProposals: proposals,
    pendingTxs,
    proposalsAddress,
    isLoading,
    pendingCount,
    refresh,
  };
}

/** Builds a Proposal-shaped row from a kind='create' PendingTx so the UI
 *  can render the just-submitted proposal before the indexer catches up. */
function synthesizePendingProposal(pt: PendingTx): Proposal {
  const summary = pt.summary;
  const receivers = (summary?.receivers ?? []).map((r, idx) => ({
    index: idx,
    address: r.address,
    amount: r.amount,
  }));
  const totalAmount = receivers.length > 0
    ? receivers.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString()
    : null;
  return {
    proposalHash: pt.proposalHash,
    proposer: pt.signerPubkey || null,
    toAddress: null,
    tokenId: null,
    txType: (summary?.txType as Proposal['txType']) ?? null,
    data: null,
    nonce: summary?.nonce ?? null,
    configNonce: summary?.configNonce ?? null,
    expiryBlock: summary?.expiryBlock ?? null,
    networkId: null,
    guardAddress: pt.contractAddress,
    destination: summary?.destination ?? null,
    childAccount: summary?.childAccount ?? null,
    status: 'pending',
    invalidReason: null,
    approvalCount: 0,
    createdAtBlock: null,
    executedAtBlock: null,
    lastApproveTxHash: null,
    lastExecuteTxHash: null,
    lastApproveError: null,
    lastExecuteError: null,
    createdAt: pt.createdAt,
    updatedAt: pt.createdAt,
    receivers,
    recipientCount: receivers.length,
    totalAmount,
    _localPending: true,
  };
}
