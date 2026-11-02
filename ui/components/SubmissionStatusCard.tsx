'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchTxStatus } from '@/lib/api';
import { truncateAddress } from '@/lib/types';
import { useAdaptivePolling } from '@/hooks/useAdaptivePolling';

export interface PendingSubmission {
  label: string;
  txHash: string | null;
}

type TxStatus = Awaited<ReturnType<typeof fetchTxStatus>>;

/** Read-only progress: confirmation never releases the contract's indexer lock. */
export default function SubmissionStatusCard({ submissions, network }: {
  submissions: PendingSubmission[];
  network: string | null;
}) {
  const primary = submissions[0];
  const txHash = primary?.txHash ?? null;
  const [confirmation, setConfirmation] = useState<{ hash: string; result: TxStatus } | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let finished = false;
    const check = async () => {
      if (!txHash || cancelled || inFlight || finished || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const result = await fetchTxStatus(txHash);
        if (!cancelled) {
          setConfirmation({ hash: txHash, result });
          finished = result?.status === 'included' || result?.status === 'failed';
        }
      } finally {
        inFlight = false;
      }
    };
    refresh.current = check;
    void check();
    return () => { cancelled = true; };
  }, [txHash]);

  // One status request per ten seconds while visible, stopping at a terminal
  // network result. The existing proposal poll still decides when to unlock.
  useAdaptivePolling(() => refresh.current(), { idleMs: 10_000 });

  if (!primary) return null;
  const status = confirmation?.hash === txHash ? confirmation.result?.status : null;
  const included = status === 'included';
  const failed = status === 'failed';
  const title = failed ? 'Transaction failed'
    : included ? 'Confirmed. Updating your Vault…'
      : status === 'pending' ? 'Waiting for network confirmation'
        : 'Checking transaction confirmation';
  const description = failed
    ? 'The network reported a failure. Waiting for the Vault status to refresh.'
    : included
      ? submissions.length > 1
        ? 'The first transaction below is confirmed. Other submissions are still awaiting a Vault update.'
        : 'The network confirmed the transaction. Waiting for it to appear in this Vault.'
      : 'The transaction was sent. This page updates automatically.';
  const steps = ['Sent', included ? 'Network confirmed' : 'Network confirmation', 'Vault updated'];

  return (
    <section aria-label="Transaction submission" role={failed ? 'alert' : 'status'} className="rounded-xl border border-safe-border bg-safe-gray overflow-hidden">
      <div className="p-5">
        <h2 className="flex items-center gap-3 text-sm font-semibold">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${failed ? 'bg-red-400' : 'bg-amber-300'}`} />
          {title}
        </h2>
        <p className="mt-2 text-sm text-safe-text">{description}</p>
        <ol aria-label="Submission progress" className="flex my-6">
          {steps.map((step, index) => {
            const done = index === 0 || index === 1 && included;
            const current = index === (included ? 2 : 1);
            return (
              <li key={index} aria-current={current ? 'step' : undefined} className="flex-1 min-w-0 text-xs">
                <div className="flex items-center mb-2">
                  <span aria-hidden="true" className={`h-6 w-6 flex shrink-0 items-center justify-center rounded-full border ${done ? 'border-safe-green text-safe-green' : current ? failed ? 'border-red-400 text-red-400' : 'border-amber-300 text-amber-300' : 'border-safe-border text-safe-text/60'}`}>
                    {done ? '✓' : current && failed ? '×' : index + 1}
                  </span>
                  {index < 2 && <span aria-hidden="true" className="h-px bg-safe-border flex-1 mx-2" />}
                </div>
                <span className={current ? 'text-white' : 'text-safe-text'}>{step}</span>
              </li>
            );
          })}
        </ol>
        <div className="space-y-2">
          {submissions.map((submission, index) => (
            <div key={submission.txHash ?? index} className="flex flex-wrap gap-x-3 gap-y-1 items-center text-xs">
              <span className="text-safe-text">{submission.label}</span>
              <TransactionLink txHash={submission.txHash} network={network} />
            </div>
          ))}
        </div>
      </div>
      <p className="border-t border-safe-border px-5 py-3 text-xs text-safe-text">
        New submissions to this Vault are paused until its transaction history updates.
      </p>
    </section>
  );
}

function TransactionLink({ txHash, network }: { txHash: string | null; network: string | null }) {
  if (!txHash) return null;
  const explorer = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL;
  const hash = <span className="font-mono">{truncateAddress(txHash, 8)}</span>;
  return explorer ? (
    <a href={`${explorer}/tx/${txHash}?network=${network ?? ''}`} target="_blank" rel="noopener noreferrer" className="text-safe-green underline underline-offset-2">
      {hash}<span className="ml-2">View transaction ↗</span>
    </a>
  ) : hash;
}
