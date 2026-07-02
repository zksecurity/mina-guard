'use client';

import { useEffect, useRef } from 'react';

/** Default cadence when no `PendingTx` is in flight. Picks up
 *  `NEXT_PUBLIC_POLL_INTERVAL_MS` so the preview-env can override. */
const DEFAULT_IDLE_MS = Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS) || 10_000;
/** Cadence while something is in flight (PendingTx visible to the user).
 *  Tight enough to make the wait feel responsive without hammering the API. */
const DEFAULT_BUSY_MS = 2_000;

interface AdaptivePollingOptions {
  /** When true, polls at `busyMs`; when false, at `idleMs`. */
  busy?: boolean;
  idleMs?: number;
  busyMs?: number;
}

/** Polls `refresh` on a configurable interval and triggers an immediate
 *  refresh whenever the tab regains focus or the network comes back online.
 *
 *  Intended for backend-poll loops where the cadence should accelerate while
 *  the user is waiting on something specific (a pending tx, a deploy) and
 *  relax when idle. The idle/busy intervals are capped at the ones provided;
 *  consumers don't need to manage the interval handle themselves.
 */
export function useAdaptivePolling(
  refresh: () => void | Promise<void>,
  options: AdaptivePollingOptions = {},
): void {
  const { busy = false, idleMs = DEFAULT_IDLE_MS, busyMs = DEFAULT_BUSY_MS } = options;

  // Hold the latest refresh in a ref so callers don't have to memoize it
  // — re-creating the interval on every render would defeat the purpose.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const intervalMs = busy ? busyMs : idleMs;
    const handle = setInterval(() => {
      void refreshRef.current();
    }, intervalMs);
    return () => clearInterval(handle);
  }, [busy, busyMs, idleMs]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRef.current();
    };
    const onOnline = () => {
      void refreshRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);
}
