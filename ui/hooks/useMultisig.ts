'use client';

import { useState, useEffect, useCallback } from 'react';
import { MultisigState } from '@/lib/types';
import {
  getMultisigState,
  saveMultisigState,
} from '@/lib/storage';

// Demo multisig state for UI development
// In production, this reads from the Mina blockchain via o1js
const DEMO_STATE: MultisigState = {
  address: 'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
  ownersRoot: '0',
  threshold: 2,
  numOwners: 3,
  txNonce: 0,
  owners: [
    'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
    'B62qjsVMsLjG75MViqXznhVGs3pGA1HfpqzxGDDMPaLQe11DEHiCJSN',
    'B62qkUHaJUHERZuCHQhXCQ8xsGBqyYSgjQsKnKN5HhSJecakuJ4pYyk',
  ],
  balance: '10000000000',
  configNonce: 0,
};

export function useMultisig(walletAddress: string | null) {
  const [state, setState] = useState<MultisigState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);

  // Load multisig state
  useEffect(() => {
    if (!walletAddress) {
      setState(null);
      return;
    }

    setIsLoading(true);
    // Try to load from localStorage, fall back to demo state
    const saved = getMultisigState(walletAddress);
    if (saved) {
      setState(saved);
    } else {
      // Initialize with demo state
      setState(DEMO_STATE);
      saveMultisigState(walletAddress, DEMO_STATE);
    }
    setIsLoading(false);
  }, [walletAddress]);

  const refreshState = useCallback(async () => {
    if (!walletAddress || !state) return;
    setIsLoading(true);
    try {
      // In production: fetch on-chain state via o1js
      // For now, reload from localStorage
      const saved = getMultisigState(walletAddress);
      if (saved) setState(saved);
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress, state]);

  const updateState = useCallback(
    (updates: Partial<MultisigState>) => {
      if (!walletAddress || !state) return;
      const newState = { ...state, ...updates };
      setState(newState);
      saveMultisigState(walletAddress, newState);
    },
    [walletAddress, state]
  );

  return {
    state,
    isLoading,
    isCompiling,
    refreshState,
    updateState,
  };
}
