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

interface TreeNode {
  contract: ContractSummary;
  children: TreeNode[];
}

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

  // Find every root whose subtree contains at least one owned node.
  const ownedRoots = new Set<string>();
  for (const c of contracts) {
    if (!ownsNode(c.address)) continue;
    // Tree depth is capped at 2 (children can't create subaccounts), so this
    // walks at most one hop today; written as a loop to stay correct if that
    // constraint ever relaxes.
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

/** Root page — shows every subtree that contains a wallet-owned account. */
export default function AccountsListPage() {
  const { contracts, allContractOwners, wallet } = useAppContext();

  const [query, setQuery] = useState('');
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

  const q = query.trim().toLowerCase();
  const matches = (c: ContractSummary): boolean => {
    if (!q) return true;
    const name = getAccountName(c.address)?.toLowerCase() ?? '';
    return c.address.toLowerCase().includes(q) || name.includes(q);
  };

  const flat = useMemo(
    () => flattenForRender(forest, collapsed, matches),
    [forest, collapsed, q],
  );

  const toggle = (address: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  return (
    <div>
      <div className="p-6 max-w-4xl mx-auto w-full">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Your accounts</h1>
            <p className="text-sm text-safe-text mt-1">
              {!wallet.address
                ? 'Connect a wallet to see your accounts.'
                : `${ownedCount} ${ownedCount === 1 ? 'account' : 'accounts'}`}
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
                placeholder="Search by address or name"
                className="w-full bg-safe-dark border border-safe-border rounded-lg pl-10 pr-3 py-2 text-sm placeholder:text-safe-text focus:outline-none focus:border-safe-green"
              />
            </div>
          </div>

          {flat.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-safe-text mb-4">
                {!wallet.address
                  ? 'Connect a wallet to see your accounts.'
                  : ownedCount === 0
                    ? "You don't own any MinaGuard accounts yet."
                    : 'No accounts match that search.'}
              </p>
              {wallet.address && ownedCount === 0 && (
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
              {flat.map(({ node, depth }) => (
                <AccountRow
                  key={node.contract.address}
                  contract={node.contract}
                  depth={depth}
                  isOwner={
                    wallet.address
                      ? allContractOwners.get(node.contract.address)?.includes(wallet.address) ?? false
                      : false
                  }
                  hasChildren={node.children.length > 0}
                  collapsed={collapsed.has(node.contract.address)}
                  onToggle={() => toggle(node.contract.address)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Flattens the forest into a render-ready list, preserving the ancestor chain for
 * search matches: a matching descendant keeps every ancestor visible so it isn't
 * orphaned. Collapsed parents hide their descendants regardless of match state.
 */
function flattenForRender(
  forest: TreeNode[],
  collapsed: Set<string>,
  matches: (c: ContractSummary) => boolean,
): Array<{ node: TreeNode; depth: number }> {
  const out: Array<{ node: TreeNode; depth: number }> = [];
  for (const root of forest) collectSubtree(root, 0, collapsed, matches, out);
  return out;
}

/** Pushes visible nodes into `scratch`, returns whether any node in the subtree matched. */
function collectSubtree(
  node: TreeNode,
  depth: number,
  collapsed: Set<string>,
  matches: (c: ContractSummary) => boolean,
  scratch: Array<{ node: TreeNode; depth: number }>,
): boolean {
  const selfMatches = matches(node.contract);
  const isCollapsed = collapsed.has(node.contract.address);

  const childRows: Array<{ node: TreeNode; depth: number }> = [];
  let anyChildMatched = false;
  if (!isCollapsed) {
    for (const child of node.children) {
      const childRowsForChild: Array<{ node: TreeNode; depth: number }> = [];
      if (collectSubtree(child, depth + 1, collapsed, matches, childRowsForChild)) {
        anyChildMatched = true;
        childRows.push(...childRowsForChild);
      }
    }
  }

  if (selfMatches || anyChildMatched) {
    scratch.push({ node, depth });
    scratch.push(...childRows);
    return true;
  }
  return false;
}

interface AccountRowProps {
  contract: ContractSummary;
  depth: number;
  isOwner: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
}

function AccountRow({
  contract,
  depth,
  isOwner,
  hasChildren,
  collapsed,
  onToggle,
}: AccountRowProps) {
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

  const indentPx = depth * 20;
  const isChild = depth > 0;

  return (
    <li className="relative">
      <Link
        href={`/accounts/${contract.address}`}
        className={`flex items-center gap-3 px-4 py-3 hover:bg-safe-hover transition-colors ${
          !isOwner ? 'opacity-70' : ''
        }`}
        style={{ paddingLeft: 16 + indentPx }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggle();
            }}
            className="w-4 h-4 flex items-center justify-center text-safe-text hover:text-white shrink-0"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            <svg
              className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-4 shrink-0 text-safe-text/60 font-mono text-xs">
            {isChild ? '└' : ''}
          </span>
        )}

        <div
          className={`${
            isChild ? 'w-8 h-8' : 'w-10 h-10'
          } rounded-full bg-safe-green/20 border border-safe-green/40 flex items-center justify-center shrink-0`}
        >
          <span className="text-safe-green font-bold text-xs">
            {contract.address.slice(3, 5).toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {name && <p className="text-sm font-semibold truncate">{name}</p>}
            {isChild && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-safe-border/40 text-safe-text shrink-0">
                Subaccount
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
