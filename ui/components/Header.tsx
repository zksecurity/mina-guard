'use client';

import Link from 'next/link';
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
        <Link
          href="/guide"
          className="flex items-center gap-1.5 text-xs font-medium text-safe-text hover:text-white transition-colors"
          title="User guide"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          <span className="hidden sm:inline">Guide</span>
        </Link>
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
