'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const DISMISSED_KEY = 'minaguard:beta-notice-dismissed';

export function BetaRiskMessage() {
  return (
    <>
      MinaGuard is in beta, including on Mainnet.{' '}
      <strong className="font-semibold text-white">You could lose funds</strong> if the
      software fails.
    </>
  );
}

/** Product status is visible on every network, in the app and standalone guide. */
export default function BetaNotice({ showGuideLink = true }: { showGuideLink?: boolean }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISSED_KEY) === 'true');
    } catch {
      // The notice remains available when browser storage is blocked.
    }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Dismissal still works until this component is remounted.
    }
  };

  if (dismissed) return null;

  return (
    <aside
      aria-label="Beta product notice"
      className="flex items-center gap-2 border-b border-safe-border bg-safe-green/10 px-4 py-2.5 text-center text-xs leading-relaxed text-safe-text sm:text-[13px]"
    >
      <div className="min-w-0 flex-1">
        <span
          aria-hidden="true"
          className="mr-2 inline-flex rounded-full bg-safe-green px-2 py-px align-middle text-[11px] font-semibold tracking-wide text-safe-dark"
        >
          BETA
        </span>
        <BetaRiskMessage />
        {showGuideLink && (
          <>
            {' '}
            <Link
              href="/guide#beta"
              className="text-safe-green underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-safe-green"
            >
              Read the beta guide
            </Link>
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss beta notice"
        onClick={dismiss}
        className="shrink-0 rounded p-1 text-safe-text hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-safe-green"
      >
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </aside>
  );
}
