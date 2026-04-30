'use client';

import { useEffect, useState } from 'react';

interface UseLoadMoreResult<T> {
  visible: T[];
  hasMore: boolean;
  visibleCount: number;
  loadMore: () => void;
  reset: () => void;
}

/**
 * Slices `items` to `pageSize` and grows by `pageSize` each `loadMore()` call.
 * Pass `initialCount` (e.g. read from URL) to restore the user's prior page on
 * mount or when polling refreshes the underlying list.
 */
export function useLoadMore<T>(
  items: T[],
  pageSize: number = 25,
  initialCount?: number,
): UseLoadMoreResult<T> {
  const [count, setCount] = useState<number>(initialCount ?? pageSize);

  useEffect(() => {
    if (initialCount != null && initialCount > count) setCount(initialCount);
  }, [initialCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = items.slice(0, count);
  return {
    visible,
    hasMore: items.length > count,
    visibleCount: count,
    loadMore: () => setCount((n) => n + pageSize),
    reset: () => setCount(pageSize),
  };
}
