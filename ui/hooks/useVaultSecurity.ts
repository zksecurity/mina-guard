'use client';

import { useEffect, useState } from 'react';
import { fetchVaultSecurityStatus, isCanonicalVaultSecurity } from '@/lib/api';

export type VaultSecurityCheck = 'checking' | 'safe' | 'unsafe' | null;

/**
 * Performs the UI's own live, field-by-field vault admission check.
 * Missing accounts, missing fields, and network failures all fail closed.
 */
export function useVaultSecurity(address: string | null): VaultSecurityCheck {
  const [check, setCheck] = useState<VaultSecurityCheck>(null);

  useEffect(() => {
    if (!address) {
      setCheck(null);
      return;
    }

    let cancelled = false;
    setCheck('checking');
    void fetchVaultSecurityStatus(address).then((status) => {
      if (!cancelled) {
        setCheck(isCanonicalVaultSecurity(status) ? 'safe' : 'unsafe');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [address]);

  return check;
}
