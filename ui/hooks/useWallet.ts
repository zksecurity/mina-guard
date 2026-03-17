'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  isAuroInstalled,
  connectAuro as connectAuroWallet,
  getAuroAccounts,
  getAuroNetwork,
  onAccountChange,
  onNetworkChange,
} from '@/lib/auroWallet';
import {
  isLedgerSupported,
  getLedgerAddress,
  disconnectLedger,
} from '@/lib/ledgerWallet';
import { WalletState } from '@/lib/types';

const EMPTY_WALLET: WalletState = {
  connected: false,
  address: null,
  network: null,
  type: null,
};

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>(EMPTY_WALLET);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auroInstalled, setAuroInstalled] = useState(false);
  const [ledgerSupported, setLedgerSupported] = useState(false);
  const manuallyDisconnected = useRef(
    typeof window !== 'undefined' && localStorage.getItem('wallet-disconnected') === 'true'
  );

  // Check capabilities on mount
  useEffect(() => {
    setAuroInstalled(isAuroInstalled());
    setLedgerSupported(isLedgerSupported());
  }, []);

  // Listen for Auro account/network changes only when connected via Auro
  useEffect(() => {
    if (!auroInstalled || wallet.type !== 'auro') return;

    const unsubAccounts = onAccountChange((accounts) => {
      if (accounts.length > 0) {
        setWallet((prev) => ({ ...prev, address: accounts[0], connected: true }));
      } else {
        setWallet(EMPTY_WALLET);
      }
    });

    const unsubNetwork = onNetworkChange((network) => {
      setWallet((prev) => ({ ...prev, network: network.name }));
    });

    return () => {
      unsubAccounts();
      unsubNetwork();
    };
  }, [auroInstalled, wallet.type]);

  // Auto-reconnect Auro if it was the last wallet type used (skip if disconnected or was Ledger)
  useEffect(() => {
    if (!auroInstalled || manuallyDisconnected.current) return;
    const lastType = typeof window !== 'undefined' ? localStorage.getItem('wallet-type') : null;
    if (lastType && lastType !== 'auro') return;
    (async () => {
      const accounts = await getAuroAccounts();
      if (accounts.length > 0) {
        const network = await getAuroNetwork();
        setWallet({
          connected: true,
          address: accounts[0],
          network,
          type: 'auro',
        });
      }
    })();
  }, [auroInstalled]);

  const connectAuro = useCallback(async () => {
    if (!auroInstalled) {
      window.open('https://www.aurowallet.com/', '_blank');
      return;
    }
    manuallyDisconnected.current = false;
    localStorage.removeItem('wallet-disconnected');
    setIsLoading(true);
    try {
      const address = await connectAuroWallet();
      if (address) {
        const network = await getAuroNetwork();
        localStorage.setItem('wallet-type', 'auro');
        setWallet({ connected: true, address, network, type: 'auro' });
      }
    } finally {
      setIsLoading(false);
    }
  }, [auroInstalled]);

  const connectingRef = useRef(false);
  const connectLedger = useCallback(async (accountIndex?: number) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const idx = typeof accountIndex === 'number' ? accountIndex : 0;
    manuallyDisconnected.current = false;
    localStorage.removeItem('wallet-disconnected');
    setIsLoading(true);
    setError(null);
    try {
      const address = await getLedgerAddress(idx);
      localStorage.setItem('wallet-type', 'ledger');
      setWallet({
        connected: true,
        address,
        network: null,
        type: 'ledger',
        ledgerAccountIndex: idx,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ledger connection failed');
    } finally {
      connectingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (wallet.type === 'ledger') {
      await disconnectLedger();
    }
    manuallyDisconnected.current = true;
    localStorage.setItem('wallet-disconnected', 'true');
    localStorage.removeItem('wallet-type');
    setWallet(EMPTY_WALLET);
  }, [wallet.type]);

  const clearError = useCallback(() => setError(null), []);

  return {
    wallet,
    isLoading,
    error,
    clearError,
    auroInstalled,
    ledgerSupported,
    connectAuro,
    connectLedger,
    disconnect,
    /** Backward-compatible alias for connectAuro. */
    connect: connectAuro,
  };
}
