'use client';

import { useEffect, useRef } from 'react';
import { BetaRiskMessage } from './BetaNotice';

/** Warn before either online proposal creation or offline request export. */
export default function BetaProposalDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="beta-proposal-title"
      aria-describedby="beta-proposal-description"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-safe-border bg-safe-dark p-6 text-white shadow-2xl backdrop:bg-black/70"
    >
      <h2 id="beta-proposal-title" className="text-xl font-semibold">Before you create a proposal</h2>
      <p id="beta-proposal-description" className="mt-3 text-sm leading-relaxed text-safe-text">
        <BetaRiskMessage />
      </p>
      <p className="mt-3 text-sm leading-relaxed text-safe-text">Use only amounts you can afford to lose.</p>
      <button
        type="button"
        autoFocus
        onClick={() => dialogRef.current?.close()}
        className="mt-6 w-full rounded-lg bg-safe-green px-4 py-3 text-sm font-semibold text-safe-dark hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-safe-green"
      >
        Continue
      </button>
    </dialog>
  );
}
