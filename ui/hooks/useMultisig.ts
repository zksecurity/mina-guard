'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchContract, fetchContracts, fetchIndexerStatus, fetchOwners } from '@/lib/api';
import { ContractSummary, IndexerStatus, OwnerRecord } from '@/lib/types';
import { clearUiStorage, getSelectedContract, saveSelectedContract } from '@/lib/storage';

/** Polls backend contract/indexer endpoints and manages selected contract state. */
export function useMultisig(walletAddress: string | null) {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [owners, setOwners] = useState<OwnerRecord[]>([]);
  const [allContractOwners, setAllContractOwners] = useState<Map<string, string[]>>(new Map());
  const [indexerStatus, setIndexerStatus] = useState<IndexerStatus | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const selectedAddressRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);

  const updateSelectedAddress = (addr: string | null) => {
    selectedAddressRef.current = addr;
    setSelectedAddress(addr);
  };

  const selectedContract = useMemo(() => {
    if (!selectedAddress) return null;
    return contracts.find((c) => c.address === selectedAddress) ?? null;
  }, [contracts, selectedAddress]);

  /** Fetches fresh contract + owners for a single address, updates state. */
  const loadContractDetail = useCallback(async (address: string) => {
    const [freshContract, ownerRows] = await Promise.all([
      fetchContract(address),
      fetchOwners(address),
    ]);
    if (selectedAddressRef.current !== address) return;
    setOwners(ownerRows.filter((o) => o.active));
    if (freshContract) {
      setContracts((prev) =>
        prev.map((c) => (c.address === freshContract.address ? freshContract : c))
      );
    }
  }, []);

  /** Fetches contracts, indexer status, and ownership map. */
  const refreshGlobalState = useCallback(async () => {
    const [contractRows, status] = await Promise.all([
      fetchContracts(),
      fetchIndexerStatus(),
    ]);
    setContracts(contractRows);
    setIndexerStatus(status);

    const ownerResults = await Promise.all(
      contractRows.map((c) =>
        fetchOwners(c.address).then((rows) => [c.address, rows] as const)
      )
    );
    const ownerMap = new Map<string, string[]>();
    for (const [addr, rows] of ownerResults) {
      ownerMap.set(addr, rows.filter((o) => o.active).map((o) => o.address));
    }
    setAllContractOwners(ownerMap);

    return { contractRows, ownerMap };
  }, []);

  /** Decides which contract to select based on wallet ownership + saved preference. */
  const resolveSelectedContract = useCallback((
    contractRows: ContractSummary[],
    ownerMap: Map<string, string[]>,
  ): string | null => {
    if (!walletAddress) {
      if (hasConnectedRef.current) {
        updateSelectedAddress(null);
        clearUiStorage();
      }
      return null;
    }

    hasConnectedRef.current = true;
    const currentAddress = selectedAddressRef.current;
    const ownedContracts = contractRows.filter(
      (c) => ownerMap.get(c.address)?.includes(walletAddress)
    );
    const stillValid = currentAddress && ownedContracts.some((c) => c.address === currentAddress);
    return stillValid ? currentAddress : ownedContracts[0]?.address ?? null;
  }, [walletAddress]);

  const initialLoadDone = useRef(false);

  /** Pulls latest global state, resolves selection, and loads detail. */
  const refreshState = useCallback(async () => {
    if (!initialLoadDone.current) setIsLoading(true);
    try {
      const { contractRows, ownerMap } = await refreshGlobalState();

      const snapshotBefore = selectedAddressRef.current;
      const resolvedAddress = resolveSelectedContract(contractRows, ownerMap);

      // If user manually selected a different contract while we were fetching, bail
      if (selectedAddressRef.current !== snapshotBefore) return;

      if (resolvedAddress) {
        updateSelectedAddress(resolvedAddress);
        saveSelectedContract(resolvedAddress);
        await loadContractDetail(resolvedAddress);
      } else {
        setOwners([]);
      }
    } finally {
      setIsLoading(false);
      initialLoadDone.current = true;
    }
  }, [refreshGlobalState, resolveSelectedContract, loadContractDetail]);

  /** Changes selected contract and refreshes owner list for the new address. */
  const selectContract = useCallback(async (address: string) => {
    updateSelectedAddress(address);
    saveSelectedContract(address);
    await loadContractDetail(address);
  }, [loadContractDetail]);

  useEffect(() => {
    const saved = getSelectedContract();
    if (saved) selectedAddressRef.current = saved;
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
