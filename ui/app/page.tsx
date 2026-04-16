'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAppContext } from '@/lib/app-context';
import ThresholdBadge from '@/components/ThresholdBadge';
import { fetchBalance } from '@/lib/api';
import { formatMina, truncateAddress, type ContractSummary } from '@/lib/types';
import { getAccountName } from '@/lib/storage';

function networkLabel(networkId: string | null): string {
  if (networkId == null) return 'Network unknown';
  if (networkId === '1') return 'Mainnet';
  if (networkId === '0') return 'Testnet';
  return `Network ${networkId}`;
}

/** Root page — lists accounts the connected wallet owns. */
export default function AccountsListPage() {
  const { contracts, allContractOwners, wallet } = useAppContext();

  const [query, setQuery] = useState('');

  const owned = useMemo(() => {
    if (!wallet.address) return [];
    return contracts.filter((c) =>
      allContractOwners.get(c.address)?.includes(wallet.address!),
    );
  }, [contracts, allContractOwners, wallet.address]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return owned;
    return owned.filter((c) => c.address.toLowerCase().includes(q));
  }, [owned, query]);

  return (
    <div>
      <div className="p-6 max-w-4xl mx-auto w-full">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Your accounts</h1>
            <p className="text-sm text-safe-text mt-1">
              {!wallet.address
                ? 'Connect a wallet to see your accounts.'
                : `${owned.length} ${owned.length === 1 ? 'account' : 'accounts'}`}
            </p>
          </div>
          <Link
            href="/accounts/new"
            className="bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2.5 text-sm hover:brightness-110 transition-all"
          >
            + Create account
          </Link>
        </div>

        <div className="bg-safe-gray border border-safe-border rounded-xl">
          <div className="p-4 border-b border-safe-border">
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-safe-text"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by address"
                className="w-full bg-safe-dark border border-safe-border rounded-lg pl-10 pr-3 py-2 text-sm placeholder:text-safe-text focus:outline-none focus:border-safe-green"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-safe-text mb-4">
                {!wallet.address
                  ? 'Connect a wallet to see your accounts.'
                  : owned.length === 0
                    ? "You don't own any MinaGuard accounts yet."
                    : 'No accounts match that search.'}
              </p>
              {wallet.address && owned.length === 0 && (
                <Link
                  href="/accounts/new"
                  className="inline-block bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2 text-sm hover:brightness-110"
                >
                  Create your first account
                </Link>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-safe-border">
              {filtered.map((contract) => (
                <AccountRow key={contract.address} contract={contract} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountRow({ contract }: { contract: ContractSummary }) {
  const [balance, setBalance] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    setName(getAccountName(contract.address));
    let cancelled = false;
    fetchBalance(contract.address).then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [contract.address]);

  return (
    <li>
      <Link
        href={`/accounts/${contract.address}`}
        className="flex items-center gap-4 px-4 py-3 hover:bg-safe-hover transition-colors"
      >
        <div className="w-10 h-10 rounded-full bg-safe-green/20 border border-safe-green/40 flex items-center justify-center shrink-0">
          <span className="text-safe-green font-bold text-sm">
            {contract.address.slice(3, 5).toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          {name && <p className="text-sm font-semibold truncate">{name}</p>}
          <p className={`font-mono truncate ${name ? 'text-xs text-safe-text' : 'text-sm'}`}>
            {truncateAddress(contract.address, 10)}
          </p>
          <p className="text-xs text-safe-text mt-0.5">{networkLabel(contract.networkId)}</p>
        </div>

        {contract.threshold != null && contract.numOwners != null && (
          <ThresholdBadge threshold={contract.threshold} numOwners={contract.numOwners} size="sm" />
        )}

        <div className="text-right w-28 shrink-0">
          <p className="text-sm font-semibold">
            {balance !== null ? formatMina(balance) : '—'}
          </p>
          <p className="text-[10px] text-safe-text">MINA</p>
        </div>

        <svg className="w-4 h-4 text-safe-text shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </li>
  );
}
