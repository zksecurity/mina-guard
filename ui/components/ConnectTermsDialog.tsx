'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BetaRiskMessage } from './BetaNotice';

const linkClass = 'text-safe-green underline underline-offset-2 hover:text-white';

/**
 * Shown once per browser (per terms version) before a wallet connects, or on
 * load when a wallet reconnected without an acceptance on record.
 */
export default function ConnectTermsDialog({ onAccept, onCancel }: { onAccept: () => void; onCancel: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // showModal focuses the first link; start on the checkbox instead.
    checkboxRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="connect-terms-title"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-safe-border bg-safe-dark p-6 text-white shadow-2xl backdrop:bg-black/70"
    >
      <h2 id="connect-terms-title" className="text-xl font-semibold">Before you connect</h2>
      <p className="mt-3 text-sm leading-relaxed text-safe-text">
        <BetaRiskMessage /> Use only amounts you can afford to lose. Mina network upgrades can also affect
        vaults; see the{' '}
        <Link href="/terms#network-upgrades" target="_blank" rel="noopener noreferrer" className={linkClass}>Terms</Link>.
      </p>
      <label className="mt-4 flex items-start gap-3 text-sm leading-relaxed text-safe-text">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--safe-green)]"
        />
        <span>
          I understand the risks and agree to the{' '}
          <Link href="/terms" target="_blank" rel="noopener noreferrer" className={linkClass}>Terms</Link>{' '}
          and{' '}
          <Link href="/privacy" target="_blank" rel="noopener noreferrer" className={linkClass}>Privacy Policy</Link>.
        </span>
      </label>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-safe-border bg-safe-gray px-4 py-3 text-sm font-semibold text-white hover:bg-safe-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!agreed}
          onClick={onAccept}
          className="flex-1 rounded-lg bg-safe-green px-4 py-3 text-sm font-semibold text-safe-dark hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
        >
          Continue
        </button>
      </div>
    </dialog>
  );
}
