'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchContract, fetchContracts, fetchIndexerStatus, fetchOwners } from '@/lib/api';
import { ContractSummary, IndexerStatus, OwnerRecord } from '@/lib/types';
import { getSelectedContract, saveSelectedContract } from '@/lib/storage';

/** Polls backend contract/indexer endpoints and manages selected contract state. */
export function useMultisig(walletAddress: string | null) {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [owners, setOwners] = useState<OwnerRecord[]>([]);
  const [allContractOwners, setAllContractOwners] = useState<Map<string, string[]>>(new Map());
  const [indexerStatus, setIndexerStatus] = useState<IndexerStatus | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const selectedContract = useMemo(() => {
    if (!selectedAddress) return null;
    return contracts.find((c) => c.address === selectedAddress) ?? null;
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

      // Fetch owners for all contracts in parallel to build ownership map
      const ownerResults = await Promise.all(
        contractRows.map((c) => fetchOwners(c.address).then((rows) => [c.address, rows] as const))
      );
      const ownerMap = new Map<string, string[]>();
      for (const [addr, rows] of ownerResults) {
        ownerMap.set(addr, rows.filter((o) => o.active).map((o) => o.address));
      }
      setAllContractOwners(ownerMap);

      // Pick a selected contract the connected wallet actually owns
      const ownedContracts = walletAddress
        ? contractRows.filter((c) => ownerMap.get(c.address)?.includes(walletAddress))
        : contractRows;

      const stillValid = selectedAddress && ownedContracts.some((c) => c.address === selectedAddress);
      const resolvedAddress = stillValid
        ? selectedAddress
        : ownedContracts[0]?.address ?? null;

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
          setContracts((prev) =>
            prev.map((c) => (c.address === freshContract.address ? freshContract : c))
          );
        }
      } else {
        setOwners([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [selectedAddress, walletAddress]);

  /** Changes selected contract and refreshes owner list for the new address. */
  const selectContract = useCallback(async (address: string) => {
    setSelectedAddress(address);
    saveSelectedContract(address);
    const [freshContract, ownerRows] = await Promise.all([
      fetchContract(address),
      fetchOwners(address),
    ]);

    if (freshContract) {
      setContracts((prev) =>
        prev.map((item) => (item.address === freshContract.address ? freshContract : item))
      );
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
    allContractOwners,
    indexerStatus,
    isLoading,
    refreshState,
    selectContract,
  };
}
