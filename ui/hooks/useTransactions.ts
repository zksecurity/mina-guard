'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProposals } from '@/lib/api';
import { Proposal } from '@/lib/types';

/** Polls backend proposal endpoints for the currently selected contract. */
export function useTransactions(multisigAddress: string | null) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const addressRef = useRef(multisigAddress);
  addressRef.current = multisigAddress;

  /** Pulls latest proposals for the active contract. */
  const refresh = useCallback(async () => {
    if (!multisigAddress) {
      setProposals([]);
      return;
    }

    setIsLoading(true);
    try {
      const rows = await fetchProposals(multisigAddress, { limit: 200, offset: 0 });
      // Bail if the address changed while fetching
      if (addressRef.current !== multisigAddress) return;
      setProposals(rows);
    } finally {
      setIsLoading(false);
    }
  }, [multisigAddress]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 10_000);

    return () => clearInterval(interval);
  }, [refresh]);

  const pendingCount = proposals.filter((p) => p.status === 'pending').length;

  return {
    proposals,
    isLoading,
    pendingCount,
    refresh,
  };
}
