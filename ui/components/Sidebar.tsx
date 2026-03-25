'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { truncateAddress, type ContractSummary, type IndexerStatus } from '@/lib/types';

interface SidebarProps {
  multisigAddress: string | null;
  contracts: ContractSummary[];
  pendingTxCount: number;
  indexerStatus: IndexerStatus | null;
  onSelectContract?: (address: string) => void;
  walletAddress: string | null;
  allContractOwners: Map<string, string[]>;
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

/** Formats a date string into a compact absolute label. */
function formatDiscoveredDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Sidebar navigation including contract selector and wallet/network context chips. */
export default function Sidebar({
  multisigAddress,
  contracts,
  pendingTxCount,
  indexerStatus,
  onSelectContract,
  walletAddress,
  allContractOwners,
}: SidebarProps) {
  const pathname = usePathname();

  // Filter contracts to only show ones the connected wallet is an owner of
  const visibleContracts = walletAddress
    ? contracts.filter((c) => {
        const owners = allContractOwners.get(c.address);
        return owners ? owners.includes(walletAddress) : false;
      })
    : [];

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

      {visibleContracts.length > 0 && (
        <div className="px-4 py-3 border-b border-safe-border">
          <p className="text-[10px] text-safe-text uppercase tracking-wider mb-2">Your Wallets</p>
          <div className="space-y-1.5 max-h-[calc(100vh-360px)] overflow-y-auto">
            {visibleContracts.map((c) => {
              const isActive = c.address === multisigAddress;
              return (
                <button
                  key={c.address}
                  onClick={() => onSelectContract?.(c.address)}
                  className={`w-full text-left rounded-lg px-3 py-2 transition-colors border ${
                    isActive
                      ? 'bg-safe-hover border-safe-green'
                      : 'bg-safe-gray border-safe-border hover:border-safe-text/40'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-safe-green' : 'bg-safe-border'}`} />
                    <span className="text-xs font-mono truncate">{truncateAddress(c.address, 8)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 ml-4">
                    {c.threshold != null && c.numOwners != null && (
                      <span className={`text-[10px] ${isActive ? 'text-safe-green' : 'text-safe-text'}`}>
                        {c.threshold}/{c.numOwners} signers
                      </span>
                    )}
                    <span className="text-[10px] text-safe-text">
                      Created: {formatDiscoveredDate(c.discoveredAt)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
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

      <div className="p-4 border-t border-safe-border space-y-2">
        {indexerStatus && (
          <div>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${indexerStatus.running ? 'bg-safe-green' : 'bg-red-500'}`} />
              <span className="text-xs text-safe-text">
                Indexer {indexerStatus.running ? 'running' : 'stopped'}
              </span>
            </div>
            {indexerStatus.lastSuccessfulRunAt && (
              <p className="text-[10px] text-safe-text ml-4">
                Synced {new Date(indexerStatus.lastSuccessfulRunAt).toLocaleTimeString()}
              </p>
            )}
            {indexerStatus.lastError && (
              <p className="text-[10px] text-red-400 ml-4 truncate" title={indexerStatus.lastError}>
                {indexerStatus.lastError}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
