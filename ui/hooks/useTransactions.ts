'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProposals } from '@/lib/api';
import { Proposal } from '@/lib/types';

/** Polls backend proposal endpoints for the currently selected contract. */
export function useTransactions(multisigAddress: string | null) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsAddress, setProposalsAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const addressRef = useRef(multisigAddress);
  const initialLoadDone = useRef(false);
  addressRef.current = multisigAddress;

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
    } finally {
      setIsLoading(false);
      initialLoadDone.current = true;
    }
  }, [multisigAddress]);

  useEffect(() => {
    // Clear stale proposals immediately so consumers don't mix old data with the new address
    setProposals([]);
    setProposalsAddress(null);
    initialLoadDone.current = false;
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 10_000);

    return () => clearInterval(interval);
  }, [refresh]);

  const pendingCount = proposals.filter((p) => p.status === 'pending').length;

  return {
    proposals,
    proposalsAddress,
    isLoading,
    pendingCount,
    refresh,
  };
}
