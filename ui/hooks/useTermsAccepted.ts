'use client';

import { useEffect, useState } from 'react';
import { hasAcceptedTerms, TERMS_ACCEPTED_EVENT } from '@/lib/terms-acceptance';

/** Whether this browser accepted the current terms; null until read on mount. */
export function useTermsAccepted(): boolean | null {
  const [accepted, setAccepted] = useState<boolean | null>(null);
  useEffect(() => {
    setAccepted(hasAcceptedTerms());
    const onAccept = () => setAccepted(true);
    window.addEventListener(TERMS_ACCEPTED_EVENT, onAccept);
    return () => window.removeEventListener(TERMS_ACCEPTED_EVENT, onAccept);
  }, []);
  return accepted;
}
