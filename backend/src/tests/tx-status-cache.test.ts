/**
 * The tx-status cache lets many clients polling one transaction hash share a
 * single node lookup per TTL. It must forget failed lookups at once, expire
 * answers after the TTL, and never grow past its size bound.
 */
import { describe, expect, test } from 'bun:test';
import { createTxStatusCache, type TxStatusResult } from '../tx-status-cache.js';

function counter(result: TxStatusResult) {
  let calls = 0;
  return {
    lookup: async () => { calls++; return result; },
    calls: () => calls,
  };
}

describe('createTxStatusCache', () => {
  test('reuses an answer within the TTL and asks again after it', async () => {
    let clock = 1_000;
    const cache = createTxStatusCache({ ttlMs: 5_000, now: () => clock });
    const node = counter({ status: 'pending' });
    expect(await cache.get('a', node.lookup)).toEqual({ status: 'pending' });
    clock += 4_999;
    expect(await cache.get('a', node.lookup)).toEqual({ status: 'pending' });
    expect(node.calls()).toBe(1);
    clock += 1;
    expect(await cache.get('a', node.lookup)).toEqual({ status: 'pending' });
    expect(node.calls()).toBe(2);
  });

  test('shares one in-flight lookup between concurrent callers', async () => {
    const cache = createTxStatusCache();
    let calls = 0;
    let release: (result: TxStatusResult) => void = () => undefined;
    const lookup = () => new Promise<TxStatusResult>((resolve) => { calls++; release = resolve; });
    const pending = [cache.get('a', lookup), cache.get('a', lookup)];
    release({ status: 'included' });
    expect(await Promise.all(pending)).toEqual([{ status: 'included' }, { status: 'included' }]);
    expect(calls).toBe(1);
  });

  test('does not remember an unknown answer or a rejected lookup', async () => {
    const cache = createTxStatusCache();
    const unknown = counter({ status: 'unknown' });
    expect(await cache.get('a', unknown.lookup)).toEqual({ status: 'unknown' });
    expect(await cache.get('a', unknown.lookup)).toEqual({ status: 'unknown' });
    expect(unknown.calls()).toBe(2);
    expect(cache.size()).toBe(0);

    let rejections = 0;
    const rejecting = async (): Promise<TxStatusResult> => { rejections++; throw new Error('node down'); };
    await expect(cache.get('b', rejecting)).rejects.toThrow('node down');
    await expect(cache.get('b', rejecting)).rejects.toThrow('node down');
    expect(rejections).toBe(2);
    expect(cache.size()).toBe(0);

    // A good answer after a failure is remembered as usual.
    const included = counter({ status: 'included' });
    await cache.get('a', included.lookup);
    await cache.get('a', included.lookup);
    expect(included.calls()).toBe(1);
  });

  test('drops the oldest hash past the size bound', async () => {
    const cache = createTxStatusCache({ maxEntries: 2 });
    const node = counter({ status: 'included' });
    await cache.get('a', node.lookup);
    await cache.get('b', node.lookup);
    await cache.get('c', node.lookup);
    expect(cache.size()).toBe(2);
    await cache.get('b', node.lookup);
    await cache.get('c', node.lookup);
    expect(node.calls()).toBe(3);
    await cache.get('a', node.lookup);
    expect(node.calls()).toBe(4);
  });
});
