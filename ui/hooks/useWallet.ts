'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import { setLedgerSigning } from '@/lib/multisigClient';
import { getMinaGuardConfig } from '@/lib/endpoints';

/** Capitalizes a network name for display (e.g. "mainnet" -> "Mainnet"). */
const capNet = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);

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

  // Check capabilities on mount, retrying briefly for Auro since the
  // extension injects window.mina asynchronously after page load.
  useEffect(() => {
    setLedgerSupported(isLedgerSupported());

    if (isAuroInstalled()) {
      setAuroInstalled(true);
      return;
    }

    // Listen for the provider injection event fired by Auro
    const onInit = () => setAuroInstalled(true);
    window.addEventListener('mina#initialized', onInit);

    // Fallback poll in case the event was missed or isn't dispatched
    const id = setInterval(() => {
      if (isAuroInstalled()) {
        setAuroInstalled(true);
        clearInterval(id);
      }
    }, 200);

    return () => {
      window.removeEventListener('mina#initialized', onInit);
      clearInterval(id);
    };
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
      setWallet((prev) => ({ ...prev, network: network.networkID.split(':')[1] ?? null }));
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
    setLedgerSigning(true, 'connecting');
    try {
      const address = await getLedgerAddress(idx);
      localStorage.setItem('wallet-type', 'ledger');
      setWallet({
        connected: true,
        address,
        // A Ledger has no network of its own; the deployment fixes it. Use the
        // same config the worker signs/broadcasts with (was the removed dropdown).
        network: getMinaGuardConfig().networkId,
        type: 'ledger',
        ledgerAccountIndex: idx,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ledger connection failed');
    } finally {
      setLedgerSigning(false);
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

  // Latest wallet snapshot, so the stable assertSigningNetwork callback can read
  // current state without being recreated.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  // Proactive WARNING banner: derived from the cached Auro network. A connected
  // Auro wallet on a different proof domain than this deployment makes owner
  // approvals fail the in-circuit verify (which always uses the devnet prefix)
  // and sends broadcasts to the wrong chain. Only mainnet vs not matters
  // (devnet/testnet share the domain). Ledger's id is pinned to the deployment,
  // so this applies only to Auro. Null cache => no banner (see the fail-closed
  // enforcement below, which does not trust the cache).
  const networkMismatch = useMemo(() => {
    if (!wallet.connected || wallet.type !== 'auro' || !wallet.network) return null;
    const deploymentNetwork = getMinaGuardConfig().networkId;
    if ((wallet.network === 'mainnet') === (deploymentNetwork === 'mainnet')) return null;
    return { walletNetwork: wallet.network, deploymentNetwork };
  }, [wallet.connected, wallet.type, wallet.network]);

  // Fail-CLOSED enforcement: re-query Auro's network LIVE right before signing.
  // The cached wallet.network can be null (Auro injects window.mina async, so
  // requestNetwork races on first load/reconnect) or stale (a missed
  // chainChanged), and trusting it would let a wrong-network approval/broadcast
  // through. Returns a block message, or null when signing may proceed.
  const assertSigningNetwork = useCallback(async (): Promise<string | null> => {
    const w = walletRef.current;
    if (!w.connected || w.type !== 'auro') return null;
    const auroNetwork = await getAuroNetwork();
    const deploymentNetwork = getMinaGuardConfig().networkId;
    if (!auroNetwork) {
      return `Can't confirm your Auro wallet's network. Unlock Auro and set it to ${capNet(deploymentNetwork)}, then retry.`;
    }
    if ((auroNetwork === 'mainnet') !== (deploymentNetwork === 'mainnet')) {
      return `Your Auro wallet is on ${capNet(auroNetwork)}, but this app runs on ${capNet(deploymentNetwork)}. Switch networks in Auro, then retry.`;
    }
    return null;
  }, []);

  return {
    wallet,
    networkMismatch,
    assertSigningNetwork,
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
