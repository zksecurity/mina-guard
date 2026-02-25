'use client';

import WalletConnect from './WalletConnect';

interface HeaderProps {
  title: string;
  subtitle?: string;
  walletAddress: string | null;
  connected: boolean;
  isLoading: boolean;
  auroInstalled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function Header({
  title,
  subtitle,
  walletAddress,
  connected,
  isLoading,
  auroInstalled,
  onConnect,
  onDisconnect,
}: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-safe-border">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        {subtitle && (
          <p className="text-sm text-safe-text mt-0.5">{subtitle}</p>
        )}
      </div>
      <WalletConnect
        address={walletAddress}
        connected={connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />
    </header>
  );
}
