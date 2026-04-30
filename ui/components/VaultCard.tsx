'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchBalance } from '@/lib/api';
import { getAccountName } from '@/lib/storage';
import ThresholdBadge from '@/components/ThresholdBadge';
import { formatMina, truncateAddress, type ContractSummary } from '@/lib/types';

interface VaultCardProps {
  contract: ContractSummary;
  isOwner?: boolean;
  /** When true, render the chevron toggle for tree expansion. */
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  /** Hides the balance fetch — useful in dense grids where the extra round-trip per card matters. */
  showBalance?: boolean;
  /** Visually marks this card as a child/sub-vault. */
  isChild?: boolean;
}

export default function VaultCard({
  contract,
  isOwner = true,
  expandable = false,
  expanded = false,
  onToggle,
  showBalance = true,
  isChild = false,
}: VaultCardProps) {
  const [balance, setBalance] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    setName(getAccountName(contract.address));
    if (!showBalance) return;
    let cancelled = false;
    fetchBalance(contract.address).then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [contract.address, showBalance]);

  return (
    <div
      className={`relative bg-safe-gray border border-safe-border rounded-xl hover:border-safe-green/40 transition-colors ${
        !isOwner ? 'opacity-70' : ''
      }`}
    >
      <Link
        href={`/accounts/${contract.address}`}
        className="block p-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-safe-green/20 border border-safe-green/40 flex items-center justify-center shrink-0">
            <span className="text-safe-green font-bold text-xs">
              {contract.address.slice(3, 5).toUpperCase()}
            </span>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              {name && <p className="text-sm font-semibold truncate">{name}</p>}
              {isChild && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-safe-border/40 text-safe-text shrink-0">
                  SubVault
                </span>
              )}
              {isChild && contract.childMultiSigEnabled === false && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 shrink-0"
                  title="Multi-sig disabled by parent"
                >
                  Multi-sig off
                </span>
              )}
              {!isOwner && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-safe-border/40 text-safe-text shrink-0">
                  View-only
                </span>
              )}
            </div>
            <p className={`font-mono truncate ${name ? 'text-xs text-safe-text mt-0.5' : 'text-sm'}`}>
              {truncateAddress(contract.address, 10)}
            </p>
          </div>

          {expandable && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggle?.();
              }}
              className="w-6 h-6 flex items-center justify-center text-safe-text hover:text-white shrink-0 -mr-1"
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              <svg
                className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-safe-border/60">
          {contract.threshold != null && contract.numOwners != null ? (
            <ThresholdBadge threshold={contract.threshold} numOwners={contract.numOwners} size="sm" />
          ) : (
            <span className="text-xs text-safe-text">—</span>
          )}
          {showBalance && (
            <div className="text-right">
              <span className="text-sm font-semibold">
                {balance !== null ? formatMina(balance) : '—'}
              </span>
              <span className="text-[10px] text-safe-text ml-1">MINA</span>
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}
