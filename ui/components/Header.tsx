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
          className="group -ml-2 flex items-center gap-2 px-2 py-1"
          title="Home"
        >
          <CubeLogo className="h-8 w-auto shrink-0 transition duration-200 ease-out group-hover:scale-[1.06] group-hover:drop-shadow-[0_0_6px_rgba(150,131,236,0.55)]" />
          <span className="hidden text-sm font-medium tracking-[0.14em] text-white/85 transition-colors duration-200 group-hover:text-white sm:inline">MINAGUARD</span>
        </Link>
        <NodeEndpointsChip />
      </div>
      <div className="flex items-center gap-3">
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
