'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Proposal } from '@/lib/types';
import {
  PENDING_TXS_CHANGED,
  getPendingTxsForContract,
  type PendingTx,
} from '@/lib/storage';

export interface ContractTxLock {
  /** True when a previously-broadcast tx targeting this contract is still
   *  waiting on indexer confirmation — submitting another now would build
   *  Merkle witnesses against stale state and fail on-chain. */
  locked: boolean;
  /** Plain-language reason shown in the disabled banner. */
  reason: string | null;
  /** Tx hash the user is waiting on, if known (own pending or server-side
   *  cross-signer signal). */
  txHash: string | null;
}

const NOT_LOCKED: ContractTxLock = { locked: false, reason: null, txHash: null };

/** Returns whether the active contract has *any* tx waiting on indexer
 *  confirmation — by any signer — that would invalidate `rebuildStoresFromBackend`
 *  for the next submission. Three signals feed into this:
 *
 *  1. **Own pending** (localStorage): create/approve/execute entries we wrote
 *     after broadcasting. Visible only to the originating tab/wallet.
 *  2. **Cross-signer approve in flight** (server): any indexed proposal whose
 *     `lastApproveTxHash` is set with no error and the proposal still pending.
 *     This is set by `recordSubmission` from any signer.
 *  3. **Cross-signer execute in flight** (server): same shape with
 *     `lastExecuteTxHash`. */
export function useContractTxLock(
  contractAddress: string | null,
  proposals: ReadonlyArray<Proposal>,
): ContractTxLock {
  const [pendingTxs, setPendingTxs] = useState<PendingTx[]>([]);

  useEffect(() => {
    if (!contractAddress) {
      setPendingTxs([]);
      return;
    }
    const reload = () => setPendingTxs(getPendingTxsForContract(contractAddress));
    reload();
    window.addEventListener(PENDING_TXS_CHANGED, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(PENDING_TXS_CHANGED, reload);
      window.removeEventListener('storage', reload);
    };
  }, [contractAddress]);

  return useMemo<ContractTxLock>(() => {
    if (!contractAddress) return NOT_LOCKED;

    // (1) Anything we ourselves submitted that hasn't reconciled yet. We
    // ignore kind='deploy' here — those mutate the *new* contract's state,
    // not the parent's stores, so they don't conflict with subsequent
    // submissions on this contract.
    const myPending = pendingTxs.find(
      (pt) => pt.kind === 'create' || pt.kind === 'approve' || pt.kind === 'execute',
    );
    if (myPending) {
      return {
        locked: true,
        reason: 'Your previous transaction is awaiting indexer confirmation.',
        txHash: myPending.txHash || null,
      };
    }

    // (2)/(3) Cross-signer signals. These are visible to every wallet via
    // the Proposal row served by the backend.
    for (const p of proposals) {
      if (p.status !== 'pending') continue;
      if (p.lastApproveTxHash && !p.lastApproveError) {
        return {
          locked: true,
          reason: 'Another signer’s approve is awaiting indexer confirmation.',
          txHash: p.lastApproveTxHash,
        };
      }
      if (p.lastExecuteTxHash && !p.lastExecuteError) {
        return {
          locked: true,
          reason: 'Another signer’s execute is awaiting indexer confirmation.',
          txHash: p.lastExecuteTxHash,
        };
      }
    }

    return NOT_LOCKED;
  }, [contractAddress, pendingTxs, proposals]);
}
