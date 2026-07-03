// TODO: verify Mesa per-block zkApp command cap; 12 is unconfirmed and
// taken from a working assumption. Once confirmed against Mesa node config,
// remove this TODO.
const TOP_N = 12;

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
 *   4. Take the median fee-per-AU.
 *   5. Multiply by `accountUpdateCount` for the caller's tx.
 *
 * NOTE: median-of-top-N from the mempool reflects what is *waiting*, not what is
 * *clearing*. In a quiet mempool this can be near zero; the node's own min-fee
 * check is the only protection. Caller is responsible for any additional floor.
 */
export async function estimateZkappFee(
  graphqlEndpoint: string,
  accountUpdateCount: number,
): Promise<FeeEstimate> {
  if (accountUpdateCount <= 0) {
    throw new Error(`accountUpdateCount must be positive, got ${accountUpdateCount}`);
  }

  const res = await fetch(graphqlEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) {
    throw new Error(`mempool query failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`mempool query errors: ${JSON.stringify(json.errors)}`);
  }
  const pool: PooledZkappCommandResult[] = json.data?.pooledZkappCommands ?? [];

  const feePerAU: number[] = [];
  for (const entry of pool) {
    const cmd = entry.zkappCommand;
    const auCount = cmd?.accountUpdates?.length ?? 0;
    if (auCount === 0) continue;
    const fee = Number(cmd?.feePayer?.body?.fee);
    if (!Number.isFinite(fee) || fee < 0) continue;
    feePerAU.push(fee / auCount);
  }
  if (feePerAU.length === 0) {
    throw new Error('mempool empty or no usable entries');
  }

  feePerAU.sort((a, b) => b - a);
  const top = feePerAU.slice(0, TOP_N);
  const medianPerAU = median([...top].sort((a, b) => a - b));

  return {
    fee: Math.ceil(medianPerAU * accountUpdateCount),
    feePerAU: medianPerAU,
    sampleSize: top.length,
  };
}

// Mina spec minimum fee per account update, per mina-signer's
// getAccountUpdateMinimumFee docstring ("0.001 according to the Mina spec").
// 0.001 MINA = 1e6 nanomina.
export const MIN_FEE_PER_AU = 1e6;

// Flat fallback when the mempool is empty or the query fails, and the floor
// under any mempool-derived estimate. 0.01 MINA covers 10 AUs at the spec
// minimum. The floor deliberately assumes 10 AUs rather than
// DEFAULT_AU_ESTIMATE: the estimate multiplies by an *assumed* AU count, but
// the built tx can carry more (per-row receivers, fundNewAccount, child
// setup) — flooring at 4 AUs could yield a sub-minimum fee the pool rejects.
// TODO: revisit if a multisig tx ever exceeds 10 AUs.
export const EMPTY_MEMPOOL_FALLBACK_FEE = 1e7;

// AU count to assume when estimating fees for multisig flows where the actual
// count isn't known until after Mina.transaction() builds the tx.
export const DEFAULT_AU_ESTIMATE = 4;

/** High-level wrapper around estimateZkappFee for callers that just want a
 *  ready-to-use fee value: returns the mempool-derived estimate floored at
 *  EMPTY_MEMPOOL_FALLBACK_FEE, which is also returned on any failure.
 *  Does not log; callers add their own logging if they want. */
export async function resolveZkappFee(graphqlEndpoint: string): Promise<number> {
  try {
    const estimate = await estimateZkappFee(graphqlEndpoint, DEFAULT_AU_ESTIMATE);
    return Math.max(estimate.fee, EMPTY_MEMPOOL_FALLBACK_FEE);
  } catch {
    return EMPTY_MEMPOOL_FALLBACK_FEE;
  }
}
