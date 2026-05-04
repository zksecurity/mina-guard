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
      // Read from window.location.search rather than the React-tracked
      // searchParams snapshot so back-to-back setters in the same commit
      // (e.g. useUrlState('search') + useUrlState('pageSize') firing
      // together) compose against the freshly-replaced URL instead of
      // each clobbering the other's write.
      const params = new URLSearchParams(window.location.search);
      if (next == null || next === '') params.delete(key);
      else params.set(key, next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [key, pathname, router],
  );

  return [value, setValue];
}
