'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Read/write a single query-param against the current URL using shallow
 * `router.replace`. Returns the current value (null when absent) and a setter
 * that writes (or removes when given an empty string / null).
 */
export function useUrlState(key: string): [string | null, (value: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(key);

  const setValue = useCallback(
    (next: string | null) => {
      // `router.replace` updates the URL asynchronously, so two setters firing
      // in the same commit (e.g. useUrlState('search') + useUrlState('pageSize')
      // on mount) would each read the same pre-replacement URL and clobber
      // each other. We use `history.replaceState` directly to mutate
      // window.location synchronously, then call `router.replace` to keep the
      // Next router tree in sync. Both writes carry the merged URL, so
      // whichever `router.replace` lands last is correct.
      const params = new URLSearchParams(window.location.search);
      if (next == null || next === '') params.delete(key);
      else params.set(key, next);
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.replaceState(null, '', url);
      router.replace(url, { scroll: false });
    },
    [key, pathname, router],
  );

  return [value, setValue];
}
