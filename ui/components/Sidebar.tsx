'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { truncateAddress } from '@/lib/types';

interface SidebarProps {
  walletAddress: string | null;
  multisigAddress: string | null;
  contracts: string[];
  pendingTxCount: number;
  network: string | null;
  onSelectContract?: (address: string) => void;
}

const navItems = [
  {
    href: '/',
    label: 'Dashboard',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: '/transactions',
    label: 'Proposals',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    ),
    showBadge: true,
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    href: '/deploy',
    label: 'Deploy',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12l-3 3m3-3l3 3" />
      </svg>
    ),
  },
];

/** Sidebar navigation including contract selector and wallet/network context chips. */
export default function Sidebar({
  walletAddress,
  multisigAddress,
  contracts,
  pendingTxCount,
  network,
  onSelectContract,
}: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="w-[240px] min-h-screen bg-safe-dark border-r border-safe-border flex flex-col">
      <div className="p-4 border-b border-safe-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-safe-green rounded-full flex items-center justify-center">
            <span className="text-safe-dark font-bold text-sm">M</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold">MinaGuard</h1>
            <span className="text-[10px] text-safe-text">Multisig Wallet</span>
          </div>
        </div>
      </div>

      {walletAddress && (
        <div className="px-4 py-3 border-b border-safe-border">
          <p className="text-[10px] text-safe-text uppercase tracking-wider mb-1">Wallet</p>
          <p className="text-xs font-mono" title={walletAddress}>
            {truncateAddress(walletAddress)}
          </p>
        </div>
      )}

      {contracts.length > 0 && (
        <div className="px-4 py-3 border-b border-safe-border">
          <p className="text-[10px] text-safe-text uppercase tracking-wider mb-1">Contract</p>
          <select
            value={multisigAddress ?? ''}
            onChange={(e) => onSelectContract?.(e.target.value)}
            className="w-full bg-safe-gray border border-safe-border rounded-lg px-2 py-1.5 text-xs font-mono"
          >
            {contracts.map((address) => (
              <option key={address} value={address}>
                {truncateAddress(address, 8)}
              </option>
            ))}
          </select>
        </div>
      )}

      <nav className="flex-1 py-2">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'text-safe-green bg-safe-hover border-r-2 border-safe-green'
                  : 'text-safe-text hover:text-white hover:bg-safe-hover'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.showBadge && pendingTxCount > 0 && (
                <span className="ml-auto bg-safe-green text-safe-dark text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {pendingTxCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-safe-border">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${network ? 'bg-safe-green' : 'bg-red-500'}`} />
          <span className="text-xs text-safe-text">{network ?? 'Not connected'}</span>
        </div>
      </div>
    </aside>
  );
}
