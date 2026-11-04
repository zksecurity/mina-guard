/**
 * Remembers recent `GET /api/tx-status` answers so that many clients polling
 * the same transaction hash ask the Mina node once per TTL. Each lookup
 * scans the node's recent blocks, and the UI polls while a transaction is in
 * flight, so without this every poll from every open tab reaches the node.
 */
export type TxStatusResult = {
  status: 'pending' | 'included' | 'failed' | 'unknown';
  reason?: string;
};

export type TxStatusCacheOptions = {
  /** How long an answer is reused. A few seconds suffices: the UI polls no
   *  more often than that, and a status only moves forward. */
  ttlMs?: number;
  /** Most hashes remembered at once; the oldest entry is dropped past it, so
   *  junk lookups cannot grow the cache without bound. */
  maxEntries?: number;
  /** Clock, replaceable in tests. */
  now?: () => number;
};

export type TxStatusCache = {
  /** Returns the remembered answer for `hash` while it is fresh, otherwise
   *  runs `lookup` and remembers its answer. Concurrent calls for the same
   *  hash share one lookup. */
  get(hash: string, lookup: () => Promise<TxStatusResult>): Promise<TxStatusResult>;
  /** Hashes currently remembered or being looked up. */
  size(): number;
};

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 1_000;

type Entry = { expiresAt: number; result: Promise<TxStatusResult> };

/** Creates an in-process cache. An `unknown` answer means the node lookup
 *  failed, so it is not remembered: the next poll asks again at once instead
 *  of every client seeing a stale failure for the TTL. A rejected lookup is
 *  forgotten the same way. */
export function createTxStatusCache(options: TxStatusCacheOptions = {}): TxStatusCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  // Insertion order is eviction order: the oldest entry goes first.
  const entries = new Map<string, Entry>();

  return {
    async get(hash, lookup) {
      const cached = entries.get(hash);
      if (cached && cached.expiresAt > now()) return cached.result;
      if (cached) entries.delete(hash);

      const entry: Entry = { expiresAt: now() + ttlMs, result: lookup() };
      entries.set(hash, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }

      try {
        const result = await entry.result;
        if (result.status === 'unknown' && entries.get(hash) === entry) entries.delete(hash);
        return result;
      } catch (error) {
        if (entries.get(hash) === entry) entries.delete(hash);
        throw error;
      }
    },
    size: () => entries.size,
  };
}
