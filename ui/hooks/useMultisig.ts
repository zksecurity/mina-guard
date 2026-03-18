'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchContract, fetchContracts, fetchIndexerStatus, fetchOwners } from '@/lib/api';
import { ContractSummary, IndexerStatus, OwnerRecord } from '@/lib/types';
import { getSelectedContract, saveSelectedContract } from '@/lib/storage';

/** Polls backend contract/indexer endpoints and manages selected contract state. */
export function useMultisig() {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [owners, setOwners] = useState<OwnerRecord[]>([]);
  const [indexerStatus, setIndexerStatus] = useState<IndexerStatus | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const selectedContract = useMemo(() => {
    if (!selectedAddress) return contracts[0] ?? null;
    return contracts.find((c) => c.address === selectedAddress) ?? contracts[0] ?? null;
  }, [contracts, selectedAddress]);

  /** Pulls latest contract list and indexer status from backend. */
  const refreshState = useCallback(async () => {
    setIsLoading(true);
    try {
      const [contractRows, status] = await Promise.all([
        fetchContracts(),
        fetchIndexerStatus(),
      ]);

      setContracts(contractRows);
      setIndexerStatus(status);

      const resolvedAddress =
        selectedAddress && contractRows.some((c) => c.address === selectedAddress)
          ? selectedAddress
          : contractRows[0]?.address ?? null;

      setSelectedAddress(resolvedAddress);
      if (resolvedAddress) {
        saveSelectedContract(resolvedAddress);
      }

      if (resolvedAddress) {
        const [freshContract, ownerRows] = await Promise.all([
          fetchContract(resolvedAddress),
          fetchOwners(resolvedAddress),
        ]);

        setOwners(ownerRows.filter((o) => o.active));

        if (freshContract) {
          setContracts((prev) => {
            const existing = prev.filter((c) => c.address !== freshContract.address);
            return [freshContract, ...existing];
          });
        }
      } else {
        setOwners([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [selectedAddress]);

  /** Changes selected contract and refreshes owner list for the new address. */
  const selectContract = useCallback(async (address: string) => {
    setSelectedAddress(address);
    saveSelectedContract(address);
    const [freshContract, ownerRows] = await Promise.all([
      fetchContract(address),
      fetchOwners(address),
    ]);

    if (freshContract) {
      setContracts((prev) => {
        const next = prev.filter((item) => item.address !== freshContract.address);
        return [freshContract, ...next];
      });
    }

    setOwners(ownerRows.filter((o) => o.active));
  }, []);

  useEffect(() => {
    const saved = getSelectedContract();
    if (saved) setSelectedAddress(saved);
    void refreshState();
    const interval = setInterval(() => {
      void refreshState();
    }, 15_000);

    return () => clearInterval(interval);
  }, [refreshState]);

  return {
    state: selectedContract,
    contracts,
    owners,
    indexerStatus,
    isLoading,
    refreshState,
    selectContract,
  };
}
