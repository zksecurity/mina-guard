'use client';

import { useEffect, useState } from 'react';

/** Delay only the loading message; callers retain their existing action gates. */
export default function VaultSecurityNotice({ checking, message }: {
  checking: boolean;
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
