import { afterEach, describe, expect, it } from 'bun:test';
import {
  AURO_TX_FEE,
  EMPTY_MEMPOOL_FALLBACK_FEE,
  estimateZkappFee,
  resolveOnlineZkappFee,
  resolveZkappFee,
} from '../lib/mempoolFee';

const originalFetch = globalThis.fetch;
const endpoint = 'https://configured-node.example/graphql';

afterEach(() => { globalThis.fetch = originalFetch; });

function pooled(fees: number[], accountUpdates = 1) {
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(url).toBe(endpoint);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body)).query).toContain('pooledZkappCommands');
    return Response.json({ data: { pooledZkappCommands: fees.map((fee) => ({
      zkappCommand: {
        feePayer: { body: { fee: String(fee) } },
        accountUpdates: Array.from({ length: accountUpdates }, () => ({ body: { publicKey: 'a' } })),
      },
    })) } });
  }) as typeof fetch;
  return () => calls;
}

describe('mempool fee selection', () => {
  it('takes the median of the top twelve fee-per-update samples', async () => {
    pooled(Array.from({ length: 13 }, (_, i) => (i + 1) * 1_000_000));
    const estimate = await estimateZkappFee(endpoint, 4);
    expect(estimate).toEqual({ fee: 30_000_000, feePerAU: 7_500_000, sampleSize: 12 });
  });

  it('uses the 0.01 MINA fallback for an empty or unavailable pool', async () => {
    pooled([]);
    expect(await resolveZkappFee(endpoint)).toBe(EMPTY_MEMPOOL_FALLBACK_FEE);
    globalThis.fetch = (async () => { throw new Error('node unavailable'); }) as unknown as typeof fetch;
    expect(await resolveZkappFee(endpoint)).toBe(EMPTY_MEMPOOL_FALLBACK_FEE);
  });

  it('falls back when the node aborts the timed query', async () => {
    globalThis.fetch = (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch;
    expect(await resolveZkappFee(endpoint)).toBe(EMPTY_MEMPOOL_FALLBACK_FEE);
  });

  it('bounds a sparse high-fee sample at the old fixed 0.1 MINA fee', async () => {
    pooled([1_000_000_000_000]);
    expect(await resolveZkappFee(endpoint)).toBe(100_000_000);
  });

  it('keeps Auro at its existing fee without querying the mempool', async () => {
    const calls = pooled([20_000_000]);
    expect(await resolveOnlineZkappFee(endpoint, 'auro')).toBe(AURO_TX_FEE);
    expect(calls()).toBe(0);
    expect(await resolveOnlineZkappFee(endpoint, 'ledger')).toBe(80_000_000);
    expect(calls()).toBe(1);
  });

  it('rejects invalid account-update estimates', async () => {
    await expect(estimateZkappFee(endpoint, 0)).rejects.toThrow('must be positive');
    await expect(estimateZkappFee(endpoint, 1.5)).rejects.toThrow('must be positive');
  });
});
