'use client';

import { useEffect, useRef, useState } from 'react';

/** Cache a preflight by its semantic inputs, not polling object identity.
 * Retry unavailable data without clearing its warning or overlapping requests. */
export function usePreflightCheck<T extends string>(
  key: string | null,
  check: () => Promise<T | 'unavailable'>,
): T | 'checking' | 'unavailable' | null {
  const checkRef = useRef(check);
  checkRef.current = check;
  const [result, setResult] = useState<{
    key: string;
    value: T | 'unavailable';
  } | null>(null);

  useEffect(() => {
    if (key === null) {
      setResult(null);
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const checkInputs = checkRef.current;
    // Clear the previous generation even if navigation later returns to its key.
    setResult(null);
    async function run() {
      let value: T | 'unavailable';
      try {
        value = await checkInputs();
      } catch {
        value = 'unavailable';
      }
      if (cancelled) return;
      setResult({ key: key!, value });
      if (value === 'unavailable') retry = setTimeout(() => void run(), 10_000);
    }
    void run();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [key]);

  if (key === null) return null;
  return result?.key === key ? result.value : 'checking';
}
