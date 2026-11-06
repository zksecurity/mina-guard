'use client';

import { useEffect, useState } from 'react';

export const VAULT_CHECK_UNAVAILABLE_MESSAGE =
  "Couldn't verify this Vault right now: the Mina node did not respond. " +
  'Actions are paused until it does; the check retries automatically.';

/** Delay only the loading message; callers retain their existing action gates. */
export default function VaultSecurityNotice({ checking, unavailable = false, message }: {
  checking: boolean;
  /** The node did not answer, so nothing is known about the Vault yet. */
  unavailable?: boolean;
  message: string;
}) {
  const [showChecking, setShowChecking] = useState(false);

  useEffect(() => {
    setShowChecking(false);
    if (!checking) return;
    const timer = setTimeout(() => setShowChecking(true), 1000);
    return () => clearTimeout(timer);
  }, [checking]);

  if (checking && !showChecking) return null;

  if (!checking && unavailable) {
    return (
      <div role="status" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-300">
        {VAULT_CHECK_UNAVAILABLE_MESSAGE}
      </div>
    );
  }

  return (
    <div
      role={checking ? 'status' : 'alert'}
      className={checking
        ? 'rounded-xl border border-safe-border p-4 text-sm text-safe-text'
        : 'rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200'}
    >
      {checking ? 'Checking vault permissions…' : message}
    </div>
  );
}
