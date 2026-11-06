'use client';

import { useEffect, useState } from 'react';
import { fetchVaultSecurityStatus, isCanonicalVaultSecurity } from '@/lib/api';

/** 'unavailable' means the node did not answer; it blocks like 'unsafe'. */
export type VaultSecurityCheck = 'checking' | 'safe' | 'unsafe' | 'unavailable' | null;

/** Re-check interval while the node is not answering. */
export const VAULT_SECURITY_RETRY_MS = 15_000;

/**
 * Performs the UI's own live, field-by-field vault admission check.
 * Missing accounts, missing fields, and network failures all fail closed.
 * Network failures are retried so the page recovers once the node is back.
 */
export function useVaultSecurity(address: string | null): VaultSecurityCheck {
  const [check, setCheck] = useState<VaultSecurityCheck>(null);

  useEffect(() => {
    if (!address) {
      setCheck(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      void fetchVaultSecurityStatus(address).then((status) => {
        if (cancelled) return;
        if (status === null) {
          setCheck('unavailable');
          timer = setTimeout(run, VAULT_SECURITY_RETRY_MS);
          return;
        }
        setCheck(isCanonicalVaultSecurity(status) ? 'safe' : 'unsafe');
      });
    };
    setCheck('checking');
    run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address]);

  return check;
}
