'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  isAuroInstalled,
  connectAuro,
  getAuroAccounts,
  getAuroNetwork,
  onAccountChange,
  onNetworkChange,
} from '@/lib/auroWallet';
import { WalletState } from '@/lib/types';

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    connected: false,
    address: null,
    network: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [auroInstalled, setAuroInstalled] = useState(false);

  // Check if Auro is installed on mount
  useEffect(() => {
    setAuroInstalled(isAuroInstalled());
  }, []);

  // Listen for account/network changes
  useEffect(() => {
    if (!auroInstalled) return;

    const unsubAccounts = onAccountChange((accounts) => {
      if (accounts.length > 0) {
        setWallet((prev) => ({ ...prev, address: accounts[0], connected: true }));
      } else {
        setWallet({ connected: false, address: null, network: null });
      }
    });

    const unsubNetwork = onNetworkChange((network) => {
      setWallet((prev) => ({ ...prev, network: network.name }));
    });

    return () => {
      unsubAccounts();
      unsubNetwork();
    };
  }, [auroInstalled]);

  // Auto-reconnect if previously connected
  useEffect(() => {
    if (!auroInstalled) return;
    (async () => {
      const accounts = await getAuroAccounts();
      if (accounts.length > 0) {
        const network = await getAuroNetwork();
        setWallet({
          connected: true,
          address: accounts[0],
          network,
        });
      }
    })();
  }, [auroInstalled]);

  const connect = useCallback(async () => {
    if (!auroInstalled) {
      window.open('https://www.aurowallet.com/', '_blank');
      return;
    }
    setIsLoading(true);
    try {
      const address = await connectAuro();
      if (address) {
        const network = await getAuroNetwork();
        setWallet({ connected: true, address, network });
      }
    } finally {
      setIsLoading(false);
    }
  }, [auroInstalled]);

  const disconnect = useCallback(() => {
    setWallet({ connected: false, address: null, network: null });
  }, []);

  return {
    wallet,
    isLoading,
    auroInstalled,
    connect,
    disconnect,
  };
}
