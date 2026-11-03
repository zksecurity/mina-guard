'use client';

import { useEffect, useState } from 'react';
import { hasAcceptedTerms, TERMS_ACCEPTED_EVENT, TERMS_ACCEPTED_KEY } from '@/lib/terms-acceptance';

/** Whether this browser accepted the current terms; null until read on mount. */
export function useTermsAccepted(): boolean | null {
  const [accepted, setAccepted] = useState<boolean | null>(null);
  useEffect(() => {
    setAccepted(hasAcceptedTerms());
    const onAccept = () => setAccepted(true);
    // Acceptance in another tab of this browser arrives as a storage event.
    const onStorage = (event: StorageEvent) => {
      if (event.key === TERMS_ACCEPTED_KEY || event.key === null) setAccepted(hasAcceptedTerms());
    };
    window.addEventListener(TERMS_ACCEPTED_EVENT, onAccept);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TERMS_ACCEPTED_EVENT, onAccept);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return accepted;
}
