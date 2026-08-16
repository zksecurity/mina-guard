'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import CubeLogo from './CubeLogo';
import WalletConnect from './WalletConnect';
import TestnetFundButton from './TestnetFundButton';
import NodeEndpointsChip from './NodeEndpointsChip';
import type { WalletType } from '@/lib/types';

interface HeaderProps {
  walletAddress: string | null;
  connected: boolean;
  isLoading: boolean;
  auroInstalled: boolean;
  ledgerSupported: boolean;
  walletType: WalletType | null;
  network: string | null;
  onConnect: () => void;
  onConnectAuro: () => void;
  onConnectLedger: (accountIndex?: number) => void;
  onDisconnect: () => void;
}

export default function Header({
  walletAddress,
  connected,
  isLoading,
  auroInstalled,
  ledgerSupported,
  walletType,
  network,
  onConnect,
  onConnectAuro,
  onConnectLedger,
  onDisconnect,
}: HeaderProps) {
  // First-visit nudge toward the guide: a soft pulse + tooltip on the Guide
  // link, shown once ever (remembered in localStorage) and dismissed on click
  // or after a few seconds. Suppressed under E2E so it never lands in captures.
  const [showGuideHint, setShowGuideHint] = useState(false);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E_TEST === 'true') return;
    let seen = true;
    try { seen = localStorage.getItem('mg_guide_hint_seen') === '1'; } catch {}
    if (seen) return;
    setShowGuideHint(true);
    try { localStorage.setItem('mg_guide_hint_seen', '1'); } catch {}
    const t = setTimeout(() => setShowGuideHint(false), 9000);
    return () => clearTimeout(t);
  }, []);

  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-safe-border">
      <div className="flex items-center gap-3 shrink-0">
        <Link
          href="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          title="Back to Vaults"
        >
          <CubeLogo className="h-8 w-auto shrink-0" />
          <span className="text-sm font-medium tracking-[0.14em] hidden sm:inline">MINAGUARD</span>
        </Link>
        <NodeEndpointsChip />
      </div>
      <div className="flex items-center gap-3">
        <div className="relative">
          <Link
            href="/guide"
            onClick={() => setShowGuideHint(false)}
            className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium transition-colors ${
              showGuideHint
                ? 'text-white ring-1 ring-safe-green/50 bg-safe-green/10 animate-guide-hint'
                : 'text-safe-text hover:text-white'
            }`}
            title="User guide"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <span className="hidden sm:inline">Guide</span>
          </Link>
          {showGuideHint && (
            <div
              role="status"
              className="animate-toast-in absolute right-0 top-full z-50 mt-2 flex items-center gap-2 whitespace-nowrap rounded-lg border border-safe-green/40 bg-safe-gray px-3 py-1.5 text-xs text-white shadow-lg shadow-black/40"
            >
              <span
                aria-hidden
                className="absolute -top-1 right-5 h-2 w-2 rotate-45 border-l border-t border-safe-green/40 bg-safe-gray"
              />
              New here? Start with the guide.
              <button
                type="button"
                onClick={() => setShowGuideHint(false)}
                aria-label="Dismiss"
                className="ml-0.5 text-base leading-none text-safe-text hover:text-white"
              >
                &times;
              </button>
            </div>
          )}
        </div>
        {network && network !== 'mainnet' && connected && walletAddress && (
          <TestnetFundButton
            address={walletAddress}
            network={network}
            explorerUrl={process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? ''}
          />
        )}
        <WalletConnect
          address={walletAddress}
          connected={connected}
          isLoading={isLoading}
          auroInstalled={auroInstalled}
          ledgerSupported={ledgerSupported}
          walletType={walletType}
          network={network}
          onConnect={onConnect}
          onConnectAuro={onConnectAuro}
          onConnectLedger={onConnectLedger}
          onDisconnect={onDisconnect}
        />
      </div>
    </header>
  );
}
