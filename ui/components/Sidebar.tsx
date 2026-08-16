'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface SidebarProps {
  multisigAddress: string | null;
  pendingTxCount: number;
}

const dashboardIcon = (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);

const navItems = [
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
];

/** Sidebar navigation. Brand lives in the top Header. */
export default function Sidebar({
  multisigAddress,
  pendingTxCount,
}: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="w-[240px] min-h-screen bg-safe-dark border-r border-safe-border flex flex-col">
      <nav className="flex-1 py-2">
        {multisigAddress && (
          <Link
            href={`/accounts/${multisigAddress}`}
            className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
              pathname.startsWith('/accounts/')
                ? 'text-safe-green bg-safe-hover border-r-2 border-safe-green'
                : 'text-safe-text hover:text-white hover:bg-safe-hover'
            }`}
          >
            {dashboardIcon}
            <span>Dashboard</span>
          </Link>
        )}
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);

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
    </aside>
  );
}
