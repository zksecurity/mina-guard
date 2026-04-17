'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import ThresholdBadge from '@/components/ThresholdBadge';
import TransactionList from '@/components/TransactionList';
import { truncateAddress, formatMina, TX_TYPES } from '@/lib/types';
import TxTypeIcon from '@/components/TxTypeIcon';
import { fetchBalance } from '@/lib/api';
import ConnectNotice from '@/components/ConnectNotice';
import Link from 'next/link';

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
    fetchBalance(multisig.address).then((b) => setBalance(b));
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
              <div className="bg-safe-gray border border-safe-green/40 rounded-xl p-5 shadow-md shadow-safe-green/20">
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

              <div className="bg-safe-gray border border-safe-green/40 rounded-xl p-5 shadow-md shadow-safe-green/20">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Threshold</p>
                <div className="mt-2">
                  <ThresholdBadge
                    threshold={multisig.threshold ?? 0}
                    numOwners={multisig.numOwners ?? owners.length}
                    size="lg"
                  />
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-green/40 rounded-xl p-5 shadow-md shadow-safe-green/20">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Wallet Balance</p>
                <p className="text-lg font-semibold mt-1">
                  {balance !== null ? formatMina(balance) : '-'}{' '}
                  <span className="text-sm text-safe-text font-normal">MINA</span>
                </p>
              </div>

              <div className="bg-safe-gray border border-safe-green/40 rounded-xl p-5 shadow-md shadow-safe-green/20">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Block Producer Delegate</p>
                <p className="text-sm font-mono mt-1 truncate" title={multisig.delegate ?? undefined}>
                  {multisig.delegate ? truncateAddress(multisig.delegate, 10) : 'None'}
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-base font-bold mb-3">New Proposal</h3>
              <div className="flex flex-wrap gap-2">
                {TX_TYPES.map((type) => (
                  <Link
                    key={type.value}
                    href={`/transactions/new?type=${type.value}`}
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-safe-gray border border-safe-border text-sm text-white font-semibold text-center transition-all hover:bg-safe-green hover:text-safe-dark hover:shadow-md hover:shadow-safe-green/20"
                  >
                    <TxTypeIcon icon={type.icon} className="w-4 h-4" />
                    {type.label}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">Recent Proposals</h3>
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

