import { OFFLINE_MAX_FEE_NANOMINA, OFFLINE_MIN_FEE_NANOMINA } from 'contracts/offline-format';

// Use the twelve highest fee-per-update commands as a market sample. The
// current mainnet node profile caps zkApp commands per block at twelve.
const TOP_N = 12;
const MEMPOOL_QUERY_TIMEOUT_MS = 10_000;

// A floor for the estimate when a pooled transaction paid almost nothing.
// This is a pricing heuristic, not the network's transaction minimum, which
// is a flat 0.001 MINA on current mainnet.
export const MIN_FEE_PER_AU = 1e6;

// The daemon wraps each pooled command in a result object; the raw command
// JSON (mina-signer wire format, fee in nanomina) lives under `zkappCommand`
// — same convention as block `zkappCommands` and the sendZkapp response.
interface PooledZkappCommandResult {
  zkappCommand: {
    feePayer: { body: { fee: string } };
    accountUpdates: unknown[];
  };
}

export interface FeeEstimate {
  fee: number;
  feePerAU: number;
  sampleSize: number;
}

/** Only a successful query with an explicit empty array confirms a quiet pool. */
class EmptyMempoolError extends Error {}

const QUERY = `{
  pooledZkappCommands {
    zkappCommand {
      feePayer { body { fee } }
      accountUpdates { body { publicKey } }
    }
  }
}`;

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) throw new Error('median of empty array');
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Estimate a zkApp tx fee from the node's current mempool.
 *
 * Algorithm:
 *   1. Query pooledZkappCommands for fee + accountUpdates.
 *   2. Compute fee-per-account-update for each entry.
 *   3. Sort descending, take top TOP_N (= 12).
 *   4. Take the median fee-per-AU, floored at MIN_FEE_PER_AU.
 *   5. Multiply by `accountUpdateCount` for the caller's tx.
 *
 * NOTE: median-of-top-N from the mempool reflects what is *waiting*, not what is
 * *clearing*. In a quiet mempool the raw median can be near zero, so the per-AU
 * rate is floored at a heuristic minimum. This cannot guarantee inclusion:
 * callers apply a flat fallback and an automatic fee ceiling below.
 */
export async function estimateZkappFee(
  graphqlEndpoint: string,
  accountUpdateCount: number,
): Promise<FeeEstimate> {
  if (!Number.isSafeInteger(accountUpdateCount) || accountUpdateCount <= 0) {
    throw new Error(`accountUpdateCount must be positive, got ${accountUpdateCount}`);
  }

  const res = await fetch(graphqlEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
    signal: AbortSignal.timeout(MEMPOOL_QUERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`mempool query failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json?.errors) {
    throw new Error(`mempool query errors: ${JSON.stringify(json.errors)}`);
  }
  const pool: PooledZkappCommandResult[] | undefined = json?.data?.pooledZkappCommands;
  if (!Array.isArray(pool)) {
    throw new Error('mempool query returned no valid pool');
  }
  if (pool.length === 0) {
    throw new EmptyMempoolError('mempool is empty');
  }

  const feePerAU: number[] = [];
  for (const entry of pool) {
    const cmd = entry?.zkappCommand;
    const auCount = Array.isArray(cmd?.accountUpdates) ? cmd.accountUpdates.length : 0;
    if (auCount === 0) continue;
    const rawFee = cmd?.feePayer?.body?.fee;
    if (typeof rawFee !== 'string' || !/^\d+$/.test(rawFee)) continue;
    const fee = Number(rawFee);
    if (!Number.isSafeInteger(fee)) continue;
    feePerAU.push(fee / auCount);
  }
  if (feePerAU.length === 0) {
    throw new Error('mempool has no usable entries');
  }

  feePerAU.sort((a, b) => b - a);
  const top = feePerAU.slice(0, TOP_N);
  const medianPerAU = median([...top].sort((a, b) => a - b));
  const flooredPerAU = Math.max(medianPerAU, MIN_FEE_PER_AU);

  return {
    fee: Math.ceil(flooredPerAU * accountUpdateCount),
    feePerAU: flooredPerAU,
    sampleSize: top.length,
  };
}

// Floor under a market estimate, and fallback for a confirmed empty pool.
// An unavailable pool uses the existing fixed fee instead; neither guarantees
// inclusion or measures the clearing price when the query fails.
export const EMPTY_MEMPOOL_FALLBACK_FEE = OFFLINE_MIN_FEE_NANOMINA;
export const UNAVAILABLE_MEMPOOL_FALLBACK_FEE = OFFLINE_MAX_FEE_NANOMINA;
/** Preserve the existing Auro fee while changing Ledger and offline flows. */
export const AURO_TX_FEE = OFFLINE_MAX_FEE_NANOMINA;

// AU count to assume when estimating fees for multisig flows where the actual
// count isn't known until after Mina.transaction() builds the tx.
export const DEFAULT_AU_ESTIMATE = 4;

/** High-level wrapper around estimateZkappFee for callers that just want a
 *  ready-to-use fee value: returns the mempool-derived estimate bounded by
 *  the floor and the automatic fee ceiling. A confirmed empty pool uses the
 *  floor; query failures or unusable responses use the existing fixed fee.
 *  Does not log; callers add their own logging if they want. */
export async function resolveZkappFee(graphqlEndpoint: string): Promise<number> {
  try {
    const estimate = await estimateZkappFee(graphqlEndpoint, DEFAULT_AU_ESTIMATE);
    return Math.min(
      Math.max(estimate.fee, EMPTY_MEMPOOL_FALLBACK_FEE),
      OFFLINE_MAX_FEE_NANOMINA,
    );
  } catch (error) {
    return error instanceof EmptyMempoolError
      ? EMPTY_MEMPOOL_FALLBACK_FEE
      : UNAVAILABLE_MEMPOOL_FALLBACK_FEE;
  }
}

/** Auro continues to use its existing embedded fee; only Ledger estimates. */
export function resolveOnlineZkappFee(
  graphqlEndpoint: string,
  signer: 'auro' | 'ledger',
): Promise<number> {
  return signer === 'ledger'
    ? resolveZkappFee(graphqlEndpoint)
    : Promise.resolve(AURO_TX_FEE);
}
