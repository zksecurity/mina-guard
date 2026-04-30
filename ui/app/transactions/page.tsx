'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useAppContext } from '@/lib/app-context';
import TransactionList from '@/components/TransactionList';
import SearchInput from '@/components/SearchInput';
import LoadMore from '@/components/LoadMore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLoadMore } from '@/hooks/useLoadMore';
import { useUrlState } from '@/hooks/useUrlState';
import Link from 'next/link';

type Tab = 'all' | 'pending' | 'executed' | 'expired' | 'invalidated';

const TABS: Tab[] = ['all', 'pending', 'executed', 'expired', 'invalidated'];
const PAGE_SIZE = 25;

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as string[]).includes(value);
}

/** Full proposal table page with lifecycle-status filtering tabs. */
export default function TransactionsPage() {
  return (
    <Suspense>
      <TransactionsPageInner />
    </Suspense>
  );
}

function TransactionsPageInner() {
  const {
    wallet,
    multisig,
    owners,
    proposals,
  } = useAppContext();

  const [urlStatus, setUrlStatus] = useUrlState('status');
  const [urlSearch, setUrlSearch] = useUrlState('search');
  const [urlPageSize, setUrlPageSize] = useUrlState('pageSize');

  const activeTab: Tab = isTab(urlStatus) ? urlStatus : 'all';
  const [searchInput, setSearchInput] = useState<string>(urlSearch ?? '');
  const debouncedSearch = useDebouncedValue(searchInput, 200);

  useEffect(() => {
    setUrlSearch(debouncedSearch || null);
  }, [debouncedSearch, setUrlSearch]);

  const setActiveTab = (tab: Tab) => {
    setUrlStatus(tab === 'all' ? null : tab);
  };

  const statusFiltered = useMemo(
    () =>
      activeTab === 'all'
        ? proposals
        : proposals.filter((p) => p.status === activeTab),
    [proposals, activeTab],
  );

  const q = debouncedSearch.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return statusFiltered;
    return statusFiltered.filter((p) => {
      if (p.memo && p.memo.toLowerCase().includes(q)) return true;
      if (p.proposer && p.proposer.toLowerCase().includes(q)) return true;
      if (p.toAddress && p.toAddress.toLowerCase().includes(q)) return true;
      // Per-receiver recipient match
      if (p.receivers.some((r) => r.address.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [statusFiltered, q]);

  // Restore the user's prior visible-count from the URL on mount and across
  // adaptive-polling refreshes so they don't snap back to the first page.
  const initialCount = (() => {
    const n = urlPageSize ? Number(urlPageSize) : NaN;
    return Number.isFinite(n) && n > 0 ? n : PAGE_SIZE;
  })();
  const { visible, hasMore, visibleCount, loadMore, reset } = useLoadMore(
    filtered,
    PAGE_SIZE,
    initialCount,
  );

  // Persist visibleCount to URL so refresh / polling restores the user's page.
  useEffect(() => {
    setUrlPageSize(visibleCount === PAGE_SIZE ? null : String(visibleCount));
  }, [visibleCount, setUrlPageSize]);

  // Reset pagination when filters change.
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, q]);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: proposals.length },
    { key: 'pending', label: 'Pending', count: proposals.filter((p) => p.status === 'pending').length },
    { key: 'executed', label: 'Executed', count: proposals.filter((p) => p.status === 'executed').length },
    { key: 'expired', label: 'Expired', count: proposals.filter((p) => p.status === 'expired').length },
    { key: 'invalidated', label: 'Invalidated', count: proposals.filter((p) => p.status === 'invalidated').length },
  ];

  return (
    <div>
      <div className="p-6">
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect wallet and select a contract to view proposals</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex gap-1 bg-safe-gray border border-safe-border rounded-lg p-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                      activeTab === tab.key
                        ? 'bg-safe-hover text-safe-green'
                        : 'text-safe-text hover:text-white'
                    }`}
                  >
                    {tab.label}
                    <span className="ml-1.5 text-xs opacity-60">{tab.count}</span>
                  </button>
                ))}
              </div>

              {multisig.ownersCommitment != null ? (
                <Link
                  href="/transactions/new"
                  className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm hover:brightness-110 transition-all"
                >
                  New Proposal
                </Link>
              ) : (
                <span
                  title="Run Setup first to initialize the contract"
                  className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm opacity-40 cursor-not-allowed"
                >
                  New Proposal
                </span>
              )}
            </div>

            <SearchInput
              value={searchInput}
              onChange={setSearchInput}
              placeholder="Search by memo, proposer, or recipient address"
            />

            <TransactionList
              proposals={visible}
              threshold={multisig.threshold ?? 0}
              owners={owners.map((owner) => owner.address)}
              emptyMessage={
                q
                  ? 'No proposals match your search'
                  : activeTab === 'all'
                    ? 'No proposals found'
                    : `No ${activeTab} proposals`
              }
            />

            <LoadMore
              visibleCount={visibleCount}
              totalCount={filtered.length}
              onClick={loadMore}
            />
            {!hasMore && filtered.length > PAGE_SIZE && (
              <p className="text-center text-[10px] text-safe-text">
                Showing all {filtered.length}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
