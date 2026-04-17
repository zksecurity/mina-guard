'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import ThresholdBadge from '@/components/ThresholdBadge';
import TransactionList from '@/components/TransactionList';
import {
  truncateAddress,
  formatMina,
  LOCAL_TX_TYPES,
  CHILD_TX_TYPES,
  type ContractSummary,
  type Proposal,
  type TxTypeOption,
} from '@/lib/types';
import TxTypeIcon from '@/components/TxTypeIcon';
import { fetchBalance, fetchChildren, fetchProposal } from '@/lib/api';
import { deployAndSetupChildOnchain } from '@/lib/multisigClient';
import ConnectNotice from '@/components/ConnectNotice';
import Link from 'next/link';
import {
  clearPendingSubaccount,
  getPendingSubaccountsForParent,
  PENDING_SUBACCOUNTS_CHANGED,
  type PendingSubaccount,
} from '@/lib/storage';

/** Account detail page — reads address from URL, syncs AppContext selection. */
export default function AccountPage() {
  const params = useParams<{ address: string }>();
  const urlAddress = params?.address ?? null;
  const searchParams = useSearchParams();
  // Set by the new-account page right after deploy submission, to differentiate
  // "indexer hasn't caught up yet" from "no such account".
  const isPendingIndex = searchParams.get('pending') === '1';

  const {
    wallet,
    multisig,
    contracts,
    allContractOwners,
    owners,
    proposals,
    indexerStatus,
    connectAuro,
    connectLedger,
    walletError,
    clearWalletError,
    auroInstalled,
    ledgerSupported,
    selectContract,
  } = useAppContext();

  const hasParent = Boolean(multisig?.parent);
  const isRoot = !hasParent;
  const isChild = hasParent;
  const isOwner = useMemo(() => {
    if (!wallet.address || !multisig) return false;
    return allContractOwners.get(multisig.address)?.includes(wallet.address) ?? false;
  }, [wallet.address, multisig, allContractOwners]);
  const childMultiSigEnabled = multisig?.childMultiSigEnabled !== false;
  const localProposalsEnabled = isOwner && (isRoot || childMultiSigEnabled);
  const childActionsEnabled = isRoot && isOwner;
  const localDisabledReason = !isOwner
    ? 'You are not an owner of this account'
    : !childMultiSigEnabled
      ? 'Multi-sig disabled by parent'
      : null;
  const parentContract = useMemo(() => {
    if (!multisig?.parent) return null;
    return contracts.find((c) => c.address === multisig.parent) ?? null;
  }, [contracts, multisig?.parent]);

  // Sync URL → selection whenever the address param or contracts list changes.
  useEffect(() => {
    if (!urlAddress) return;
    if (multisig?.address === urlAddress) return;
    const exists = contracts.some((c) => c.address === urlAddress);
    if (exists) void selectContract(urlAddress);
  }, [urlAddress, contracts, multisig?.address, selectContract]);

  const recent = [...proposals].slice(0, 5);

  const [balance, setBalance] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);

  useEffect(() => {
    if (!multisig?.address) return;
    let cancelled = false;
    fetchBalance(multisig.address).then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => { cancelled = true; };
  }, [multisig?.address, indexerStatus?.lastSuccessfulRunAt]);

  return (
    <div>
      <div className="p-6">
        {!wallet.connected ? (
          <ConnectNotice
            onConnectAuro={connectAuro}
            onConnectLedger={connectLedger}
            auroInstalled={auroInstalled}
            ledgerSupported={ledgerSupported}
            error={walletError}
            onClearError={clearWalletError}
          />
        ) : multisig && multisig.address === urlAddress ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Wallet Address</p>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-mono flex min-w-0">
                    <span className="truncate">{multisig.address.slice(0, -4)}</span>
                    <span className="shrink-0">{multisig.address.slice(-4)}</span>
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(multisig.address);
                      setCopiedAddress(true);
                      setTimeout(() => setCopiedAddress(false), 1500);
                    }}
                    title="Copy address"
                    className="text-safe-text hover:text-white transition-colors"
                  >
                    {copiedAddress ? (
                      <svg className="w-3.5 h-3.5 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Threshold</p>
                <div className="mt-2">
                  <ThresholdBadge
                    threshold={multisig.threshold ?? 0}
                    numOwners={multisig.numOwners ?? owners.length}
                    size="lg"
                  />
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Wallet Balance</p>
                <p className="text-lg font-semibold mt-1">
                  {balance !== null ? formatMina(balance) : '-'}{' '}
                  <span className="text-sm text-safe-text font-normal">MINA</span>
                </p>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Block Producer Delegate</p>
                <p className="text-sm font-mono mt-1 truncate" title={multisig.delegate ?? undefined}>
                  {multisig.delegate ? truncateAddress(multisig.delegate, 10) : 'None'}
                </p>
              </div>
            </div>

            {isRoot && (
              <PendingSubaccountsBanner parentAddress={multisig.address} isOwner={isOwner} />
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <OwnersCard
                owners={owners.map((o) => o.address)}
                walletAddress={wallet.address}
                threshold={multisig.threshold ?? 0}
              />
              {isRoot ? (
                <SubaccountsCard parentAddress={multisig.address} />
              ) : (
                <ParentCard
                  parent={multisig.parent!}
                  parentContract={parentContract}
                  childMultiSigEnabled={childMultiSigEnabled}
                />
              )}
            </div>

            <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
              <p className="text-xs text-safe-text uppercase tracking-wider mb-3">New Proposal</p>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[10px] text-safe-text uppercase tracking-wider shrink-0 w-20">Account</span>
                  <ProposalButtonRow
                    types={LOCAL_TX_TYPES}
                    enabled={localProposalsEnabled}
                    disabledReason={localDisabledReason}
                    hrefPrefix={`/transactions/new?account=${multisig.address}&type=`}
                    accountAddress={multisig.address}
                  />
                </div>
                {isRoot && (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-[10px] text-safe-text uppercase tracking-wider shrink-0 w-20">Subaccount</span>
                    <ProposalButtonRow
                      types={CHILD_TX_TYPES}
                      enabled={childActionsEnabled}
                      disabledReason={!isOwner ? 'You are not an owner of this account' : null}
                      hrefPrefix={`/transactions/new?account=${multisig.address}&type=`}
                      accountAddress={multisig.address}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-safe-text uppercase tracking-wider">Recent Proposals</p>
                <Link href="/transactions" className="text-xs text-safe-green hover:underline">
                  View all
                </Link>
              </div>
              <TransactionList
                proposals={recent}
                threshold={multisig.threshold ?? 0}
                owners={owners.map((owner) => owner.address)}
                emptyMessage="No proposals indexed yet"
              />
            </div>
          </div>
        ) : urlAddress && !contracts.some((c) => c.address === urlAddress) ? (
          isPendingIndex ? (
            <div className="text-center py-20">
              <p className="text-safe-text">Your account will appear here shortly…</p>
            </div>
          ) : (
            <div className="text-center py-20">
              <p className="text-safe-text mb-4">Account not found.</p>
              <Link
                href="/"
                className="inline-block bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
              >
                Back to accounts
              </Link>
            </div>
          )
        ) : (
          <div className="text-center py-20">
            <p className="text-safe-text">Loading account…</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface ProposalButtonRowProps {
  types: TxTypeOption[];
  enabled: boolean;
  disabledReason: string | null;
  hrefPrefix: string;
  /** Address of the contract these buttons target — needed for type-specific routing. */
  accountAddress: string;
}

function ProposalButtonRow({ types, enabled, disabledReason, hrefPrefix, accountAddress }: ProposalButtonRowProps) {
  // createChild lives in the wizard, not in /transactions/new — route around the
  // generic proposal form so we don't bounce through it on click.
  const hrefFor = (typeValue: string): string => {
    if (typeValue === 'createChild') return `/accounts/new?parent=${accountAddress}`;
    return `${hrefPrefix}${typeValue}`;
  };

  return (
    <div className="flex flex-wrap gap-2">
      {types.map((type) => {
        const className =
          'flex items-center gap-2 px-4 py-2 rounded-full bg-safe-gray border border-safe-border text-sm font-semibold text-center transition-all';
        if (!enabled) {
          return (
            <span
              key={type.value}
              className={`${className} text-safe-text/60 cursor-not-allowed`}
              title={disabledReason ?? 'Unavailable'}
            >
              <TxTypeIcon icon={type.icon} className="w-4 h-4" />
              {type.label}
            </span>
          );
        }
        return (
          <Link
            key={type.value}
            href={hrefFor(type.value)}
            className={`${className} text-white hover:bg-safe-green hover:text-safe-dark hover:shadow-md hover:shadow-safe-green/20`}
          >
            <TxTypeIcon icon={type.icon} className="w-4 h-4" />
            {type.label}
          </Link>
        );
      })}
    </div>
  );
}

interface OwnersCardProps {
  owners: string[];
  walletAddress: string | null;
  threshold: number;
}

function OwnersCard({ owners, walletAddress, threshold }: OwnersCardProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopied(address);
    setTimeout(() => setCopied((current) => (current === address ? null : current)), 1500);
  };

  return (
    <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-safe-text uppercase tracking-wider">
          Owners ({owners.length})
        </p>
        <p className="text-[10px] text-safe-text uppercase tracking-wider">
          Threshold {threshold}/{owners.length}
        </p>
      </div>
      {owners.length === 0 ? (
        <p className="text-sm text-safe-text">No owners indexed yet.</p>
      ) : (
        <ul className="divide-y divide-safe-border">
          {owners.map((address) => {
            const isSelf = walletAddress === address;
            return (
              <li
                key={address}
                className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="w-7 h-7 rounded-full bg-safe-green/20 border border-safe-green/40 flex items-center justify-center shrink-0">
                  <span className="text-safe-green font-bold text-[10px]">
                    {address.slice(3, 5).toUpperCase()}
                  </span>
                </div>
                <span className="text-sm font-mono truncate flex-1" title={address}>
                  {truncateAddress(address, 12)}
                </span>
                {isSelf && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-safe-green/15 text-safe-green shrink-0">
                    You
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleCopy(address)}
                  className="text-safe-text hover:text-white transition-colors shrink-0"
                  title="Copy address"
                >
                  {copied === address ? (
                    <svg className="w-3.5 h-3.5 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface ParentCardProps {
  parent: string;
  parentContract: ContractSummary | null;
  childMultiSigEnabled: boolean;
}

function ParentCard({ parent, parentContract, childMultiSigEnabled }: ParentCardProps) {
  return (
    <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Parent Account</p>
          <Link
            href={`/accounts/${parent}`}
            className="text-sm font-mono text-safe-green hover:underline truncate block"
            title={parent}
          >
            {parentContract ? truncateAddress(parent, 10) : truncateAddress(parent, 10)}
          </Link>
          <p className="text-xs text-safe-text mt-1">
            Multi-sig:{' '}
            <span className={childMultiSigEnabled ? 'text-safe-green' : 'text-amber-400'}>
              {childMultiSigEnabled ? 'Enabled' : 'Disabled by parent'}
            </span>
          </p>
        </div>
        <Link
          href={`/accounts/${parent}`}
          className="text-xs text-safe-green hover:underline shrink-0"
        >
          Open parent →
        </Link>
      </div>
    </div>
  );
}

function PendingSubaccountsBanner({
  parentAddress,
  isOwner,
}: {
  parentAddress: string;
  isOwner: boolean;
}) {
  const { wallet, indexerStatus, contracts, proposals, multisig, startOperation, isOperating } = useAppContext();
  const [pending, setPending] = useState<PendingSubaccount[]>([]);
  const parentThreshold = multisig?.address === parentAddress ? (multisig.threshold ?? 0) : 0;

  // Reload from localStorage when the parent changes, the indexer ticks, or
  // savePendingSubaccount/clearPendingSubaccount fires its custom event (so
  // the banner refreshes immediately after the wizard's background save).
  useEffect(() => {
    const reload = () => setPending(getPendingSubaccountsForParent(parentAddress));
    reload();
    window.addEventListener(PENDING_SUBACCOUNTS_CHANGED, reload);
    return () => window.removeEventListener(PENDING_SUBACCOUNTS_CHANGED, reload);
  }, [parentAddress, indexerStatus?.lastSuccessfulRunAt]);

  // Hide entries whose child has already been indexed.
  const visible = useMemo(() => {
    const indexedAddresses = new Set(contracts.map((c) => c.address));
    return pending.filter((p) => !indexedAddresses.has(p.childAddress));
  }, [pending, contracts]);

  // Auto-clean records for already-indexed children.
  useEffect(() => {
    const indexedAddresses = new Set(contracts.map((c) => c.address));
    const stale = pending.filter((p) => indexedAddresses.has(p.childAddress));
    for (const p of stale) {
      clearPendingSubaccount(p.parentAddress, p.childAddress);
    }
    if (stale.length > 0) {
      setPending(getPendingSubaccountsForParent(parentAddress));
    }
  }, [pending, contracts, parentAddress]);

  if (visible.length === 0) return null;

  const handleFinalize = async (record: PendingSubaccount) => {
    if (!wallet.address) return;
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    void startOperation('Finalizing subaccount deployment…', async (onProgress) => {
      onProgress('Fetching parent CREATE_CHILD proposal…');
      const proposal = await fetchProposal(record.parentAddress, record.proposalHash);
      if (!proposal) {
        throw new Error('Parent proposal not found in indexer yet — try again in a moment.');
      }
      const result = await deployAndSetupChildOnchain({
        parentAddress: record.parentAddress,
        childPrivateKeyBase58: record.childPrivateKey,
        feePayerAddress: wallet.address!,
        childOwners: record.childOwners,
        childThreshold: record.childThreshold,
        proposal,
      }, onProgress, signer);
      return result;
    });
  };

  return (
    <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-amber-200">Pending Subaccounts ({visible.length})</h3>
      </div>
      <ul className="space-y-2">
        {visible.map((record) => {
          const proposal = proposals.find((p) => p.proposalHash === record.proposalHash);
          // Proposal must be indexed, still pending, and at or above the
          // parent's threshold before executeSetupChild can succeed.
          const thresholdMet = !!proposal && proposal.status === 'pending' && proposal.approvalCount >= parentThreshold;
          const canFinalize = thresholdMet;
          const statusHint = !proposal
            ? 'Waiting for indexer…'
            : proposal.status !== 'pending'
              ? `Proposal ${proposal.status}`
              : proposal.approvalCount < parentThreshold
                ? `${proposal.approvalCount}/${parentThreshold} approvals`
                : null;
          return (
            <li
              key={`${record.parentAddress}:${record.childAddress}`}
              className="bg-safe-dark border border-safe-border rounded-lg px-3 py-2 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                {record.childName && (
                  <p className="text-sm font-semibold truncate">{record.childName}</p>
                )}
                <p className="font-mono text-xs text-safe-text truncate">
                  {truncateAddress(record.childAddress, 10)}
                </p>
                <p className="text-[10px] text-safe-text mt-0.5">
                  Proposal {record.proposalHash.slice(0, 10)}… ·{' '}
                  {record.childThreshold}/{record.childOwners.length} owners
                  {statusHint && <> · <span className="text-amber-300">{statusHint}</span></>}
                </p>
              </div>
              {isOwner && (
                <button
                  type="button"
                  disabled={isOperating || !canFinalize}
                  onClick={() => handleFinalize(record)}
                  className="bg-safe-green text-safe-dark text-xs font-semibold rounded-lg px-3 py-1.5 hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  title={canFinalize
                    ? 'Runs executeSetupChild on the new child address.'
                    : 'Waiting for the parent CREATE_CHILD proposal to reach threshold.'}
                >
                  {isOperating ? 'Finalizing…' : 'Finalize deployment'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SubaccountsCard({ parentAddress }: { parentAddress: string }) {
  const { indexerStatus } = useAppContext();
  const [children, setChildren] = useState<ContractSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchChildren(parentAddress).then((list) => {
      if (!cancelled) setChildren(list);
    });
    return () => {
      cancelled = true;
    };
  }, [parentAddress, indexerStatus?.lastSuccessfulRunAt]);

  if (children === null) {
    return (
      <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
        <p className="text-xs text-safe-text uppercase tracking-wider mb-2">Subaccounts</p>
        <p className="text-sm text-safe-text">Loading…</p>
      </div>
    );
  }

  if (children.length === 0) {
    return (
      <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
        <p className="text-xs text-safe-text uppercase tracking-wider mb-2">Subaccounts</p>
        <p className="text-sm text-safe-text">No subaccounts yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-safe-text uppercase tracking-wider">
          Subaccounts ({children.length})
        </p>
      </div>
      <ul className="divide-y divide-safe-border">
        {children.map((child) => (
          <li key={child.address}>
            <Link
              href={`/accounts/${child.address}`}
              className="flex items-center justify-between gap-3 py-2 hover:bg-safe-hover transition-colors -mx-2 px-2 rounded"
            >
              <div className="min-w-0">
                <p className="text-sm font-mono truncate">{truncateAddress(child.address, 10)}</p>
                <p className="text-[10px] text-safe-text mt-0.5">
                  {child.threshold != null && child.numOwners != null
                    ? `${child.threshold}/${child.numOwners}`
                    : '—'}
                  {child.childMultiSigEnabled === false && (
                    <span className="ml-2 text-amber-400">multi-sig off</span>
                  )}
                </p>
              </div>
              <span className="text-xs text-safe-green">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
