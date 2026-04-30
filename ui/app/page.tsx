'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAppContext } from '@/lib/app-context';
import SearchInput from '@/components/SearchInput';
import LoadMore from '@/components/LoadMore';
import VaultCard from '@/components/VaultCard';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLoadMore } from '@/hooks/useLoadMore';
import { useUrlState } from '@/hooks/useUrlState';
import { truncateAddress, type ContractSummary } from '@/lib/types';
import {
  getAccountName,
  getPendingTxs,
  PENDING_TXS_CHANGED,
  type PendingTx,
} from '@/lib/storage';

interface TreeNode {
  contract: ContractSummary;
  children: TreeNode[];
}

const PAGE_SIZE = 25;

/**
 * Builds forest of owned subtrees.
 * Rule: a tree is visible if the connected wallet owns ANY node in the tree
 * (lineage owner → full subtree including siblings they don't own).
 */
function buildOwnedForest(
  contracts: ContractSummary[],
  allContractOwners: Map<string, string[]>,
  walletAddress: string | null,
): TreeNode[] {
  if (!walletAddress) return [];

  const byAddress = new Map<string, ContractSummary>();
  const childrenByParent = new Map<string, ContractSummary[]>();
  for (const c of contracts) {
    byAddress.set(c.address, c);
    if (c.parent) {
      const siblings = childrenByParent.get(c.parent) ?? [];
      siblings.push(c);
      childrenByParent.set(c.parent, siblings);
    }
  }

  const ownsNode = (addr: string): boolean =>
    allContractOwners.get(addr)?.includes(walletAddress) ?? false;

  const ownedRoots = new Set<string>();
  for (const c of contracts) {
    if (!ownsNode(c.address)) continue;
    let current: ContractSummary | undefined = c;
    while (current?.parent) {
      const next = byAddress.get(current.parent);
      if (!next) break;
      current = next;
    }
    if (current) ownedRoots.add(current.address);
  }

  const buildNode = (contract: ContractSummary): TreeNode => {
    const children = (childrenByParent.get(contract.address) ?? [])
      .slice()
      .sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))
      .map(buildNode);
    return { contract, children };
  };

  return [...ownedRoots]
    .map((addr) => byAddress.get(addr))
    .filter((c): c is ContractSummary => Boolean(c))
    .sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))
    .map(buildNode);
}

/** Returns true if the node's subtree contains a node where `matches` returns true. */
function subtreeHasMatch(node: TreeNode, matches: (c: ContractSummary) => boolean): boolean {
  if (matches(node.contract)) return true;
  return node.children.some((child) => subtreeHasMatch(child, matches));
}

/** Root page — shows every subtree that contains a wallet-owned account. */
export default function AccountsListPage() {
  return (
    <Suspense>
      <AccountsListPageInner />
    </Suspense>
  );
}

function AccountsListPageInner() {
  const { contracts, allContractOwners, wallet } = useAppContext();

  const [urlQuery, setUrlQuery] = useUrlState('search');
  const [query, setQuery] = useState<string>(urlQuery ?? '');
  const debouncedQuery = useDebouncedValue(query, 200);

  // Sync the debounced value into the URL so refresh / share preserves search.
  useEffect(() => {
    setUrlQuery(debouncedQuery || null);
  }, [debouncedQuery, setUrlQuery]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const forest = useMemo(
    () => buildOwnedForest(contracts, allContractOwners, wallet.address),
    [contracts, allContractOwners, wallet.address],
  );

  const ownedCount = useMemo(() => {
    if (!wallet.address) return 0;
    return contracts.filter((c) =>
      allContractOwners.get(c.address)?.includes(wallet.address!),
    ).length;
  }, [contracts, allContractOwners, wallet.address]);

  // Pending deploys for the connected wallet — shown above the indexed list
  // so the user can navigate back to a deploying account before it indexes.
  const [pendingDeploys, setPendingDeploys] = useState<PendingTx[]>([]);
  useEffect(() => {
    const reload = () => {
      if (!wallet.address) {
        setPendingDeploys([]);
        return;
      }
      const indexed = new Set(contracts.map((c) => c.address));
      const next = getPendingTxs().filter(
        (pt) =>
          pt.kind === 'deploy' &&
          pt.signerPubkey === wallet.address &&
          !indexed.has(pt.contractAddress),
      );
      setPendingDeploys(next);
    };
    reload();
    window.addEventListener(PENDING_TXS_CHANGED, reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener(PENDING_TXS_CHANGED, reload);
      window.removeEventListener('storage', reload);
    };
  }, [wallet.address, contracts]);

  const explorerUrl = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? '';

  const q = debouncedQuery.trim().toLowerCase();
  const matches = (c: ContractSummary): boolean => {
    if (!q) return true;
    const name = getAccountName(c.address)?.toLowerCase() ?? '';
    return c.address.toLowerCase().includes(q) || name.includes(q);
  };

  // When searching, restrict roots to subtrees containing a match.
  const filteredRoots = useMemo(() => {
    if (!q) return forest;
    return forest.filter((root) => subtreeHasMatch(root, matches));
    // matches closes over q; tracked via debouncedQuery dep below
  }, [forest, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const { visible: visibleRoots, hasMore, visibleCount, loadMore, reset } =
    useLoadMore(filteredRoots, PAGE_SIZE);

  // Reset pagination when the search filter changes.
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const toggle = (address: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  // While searching, force-expand any root whose subtree matched (so children
  // are visible even if the user had previously collapsed it).
  const isExpanded = (root: TreeNode): boolean => {
    if (q) return true;
    return !collapsed.has(root.contract.address);
  };

  const isOwnerOf = (address: string): boolean =>
    wallet.address
      ? allContractOwners.get(address)?.includes(wallet.address) ?? false
      : false;

  return (
    <div>
      <div className="p-6 max-w-5xl mx-auto w-full">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Your Vaults</h1>
            <p className="text-sm text-safe-text mt-1">
              {!wallet.address
                ? 'Connect a wallet to see your Vaults.'
                : `${ownedCount} ${ownedCount === 1 ? 'Vault' : 'Vaults'}`}
            </p>
          </div>
          <Link
            href="/accounts/new"
            className="bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2.5 text-sm hover:brightness-110 transition-all"
          >
            + Create Vault
          </Link>
        </div>

        {pendingDeploys.length > 0 && (
          <ul className="bg-safe-gray border border-yellow-400/30 rounded-xl divide-y divide-safe-border mb-4 overflow-hidden">
            {pendingDeploys.map((pt) => (
              <PendingDeployRow
                key={pt.contractAddress}
                pendingTx={pt}
                explorerUrl={explorerUrl}
                network={wallet.network}
              />
            ))}
          </ul>
        )}

        <div className="mb-4">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search by address or name"
          />
        </div>

        {visibleRoots.length === 0 ? (
          <div className="bg-safe-gray border border-safe-border rounded-xl p-10 text-center">
            <p className="text-safe-text mb-4">
              {!wallet.address
                ? 'Connect a wallet to see your Vaults.'
                : ownedCount === 0
                  ? "You don't own any MinaGuard Vaults yet."
                  : 'No Vaults match that search.'}
            </p>
            {wallet.address && ownedCount === 0 && (
              <Link
                href="/accounts/new"
                className="inline-block bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2 text-sm hover:brightness-110"
              >
                Create your first Vault
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleRoots.map((root) => (
                <RootGroup
                  key={root.contract.address}
                  root={root}
                  expanded={isExpanded(root)}
                  onToggle={() => toggle(root.contract.address)}
                  isOwnerOf={isOwnerOf}
                  matches={matches}
                  filterActive={Boolean(q)}
                />
              ))}
            </div>
            <LoadMore visibleCount={visibleCount} totalCount={filteredRoots.length} onClick={loadMore} />
            {!hasMore && filteredRoots.length > PAGE_SIZE && (
              <p className="text-center text-[10px] text-safe-text pb-4">
                Showing all {filteredRoots.length}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface RootGroupProps {
  root: TreeNode;
  expanded: boolean;
  onToggle: () => void;
  isOwnerOf: (address: string) => boolean;
  matches: (c: ContractSummary) => boolean;
  /** True when a search query is active — children are filtered to matches only. */
  filterActive: boolean;
}

/**
 * Renders one root vault card and, when expanded, a nested card grid of its
 * children. Tree depth is capped at 2 (children can't create subaccounts).
 */
function RootGroup({ root, expanded, onToggle, isOwnerOf, matches, filterActive }: RootGroupProps) {
  const hasChildren = root.children.length > 0;
  const visibleChildren = filterActive
    ? root.children.filter((child) => matches(child.contract))
    : root.children;

  return (
    <div className="flex flex-col gap-2">
      <VaultCard
        contract={root.contract}
        isOwner={isOwnerOf(root.contract.address)}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded && visibleChildren.length > 0 && (
        <div className="ml-4 pl-3 border-l border-safe-border/60 grid grid-cols-1 gap-2">
          {visibleChildren.map((child) => (
            <VaultCard
              key={child.contract.address}
              contract={child.contract}
              isOwner={isOwnerOf(child.contract.address)}
              isChild
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Top-of-list row for an account whose deploy tx is broadcast but not yet
 *  indexed. Links to /accounts/<address> so the user can return to the
 *  pending detail page; auto-disappears once the indexer surfaces the
 *  contract (cleanup happens on the detail page). */
function PendingDeployRow({
  pendingTx,
  explorerUrl,
  network,
}: {
  pendingTx: PendingTx;
  explorerUrl: string;
  network: string | null;
}) {
  const name = getAccountName(pendingTx.contractAddress);
  return (
    <li>
      <Link
        href={`/accounts/${pendingTx.contractAddress}`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-safe-hover transition-colors"
      >
        <div className="w-10 h-10 rounded-full bg-yellow-400/15 border border-yellow-400/40 flex items-center justify-center shrink-0">
          <span className="text-yellow-300 font-bold text-xs">
            {pendingTx.contractAddress.slice(3, 5).toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {name && <p className="text-sm font-semibold truncate">{name}</p>}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-400/10 border border-yellow-400/30 text-yellow-200 shrink-0">
              Deploying
            </span>
          </div>
          <p className={`font-mono truncate ${name ? 'text-xs text-safe-text' : 'text-sm'}`}>
            {truncateAddress(pendingTx.contractAddress, 10)}
          </p>
          <p className="text-xs text-safe-text mt-0.5 font-mono">
            {explorerUrl ? (
              <a
                href={`${explorerUrl}/tx/${pendingTx.txHash}?network=${network ?? ''}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="underline hover:opacity-70"
              >
                {truncateAddress(pendingTx.txHash, 8)}
              </a>
            ) : (
              truncateAddress(pendingTx.txHash, 8)
            )}
          </p>
        </div>

        <svg className="w-4 h-4 text-safe-text shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </li>
  );
}
