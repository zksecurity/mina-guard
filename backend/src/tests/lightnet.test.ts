import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  acquireLightnetAccount,
  computeFundingAmount,
  LightnetAcquireError,
  withLightnetAccount,
} from '../lightnet.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe('acquireLightnetAccount', () => {
  test('requests a regular account and returns the validated keypair', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        'http://127.0.0.1:8181/acquire-account?isRegularAccount=true'
      );

      return new Response(JSON.stringify({ pk: 'B62test', sk: 'EKFtest' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      acquireLightnetAccount('http://127.0.0.1:8181')
    ).resolves.toEqual({ pk: 'B62test', sk: 'EKFtest' });
  });

  test('throws a useful error on invalid JSON', async () => {
    globalThis.fetch = mock(async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as typeof fetch;

    await expect(
      acquireLightnetAccount('http://127.0.0.1:8181')
    ).rejects.toThrow('Account manager returned invalid JSON');
  });

  test('throws a useful error on invalid payload shape', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ publicKey: 'B62test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as typeof fetch;

    await expect(
      acquireLightnetAccount('http://127.0.0.1:8181')
    ).rejects.toThrow('Account manager returned an invalid account payload');
  });
});

describe('computeFundingAmount', () => {
  test('caps funding at the desired amount', () => {
    expect(computeFundingAmount(200_000_000_000n)).toBe(50_000_000_000n);
  });

  test('uses the available balance when it is below the desired amount', () => {
    expect(computeFundingAmount(20_000_000_000n)).toBe(18_900_000_000n);
  });

  test('returns zero when the reserve cannot be covered', () => {
    expect(computeFundingAmount(1_000_000_000n)).toBe(0n);
  });
});

describe('withLightnetAccount', () => {
  test('releases the acquired account after an early return', async () => {
    const release = mock(async () => {});
    const run = mock(async () => null);

    await expect(
      withLightnetAccount(
        'http://127.0.0.1:8181',
        run,
        {
          acquireLightnetAccount: async () => ({ pk: 'B62test', sk: 'EKFtest' }),
          releaseLightnetAccount: release,
        }
      )
    ).resolves.toBeNull();

    expect(run).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('http://127.0.0.1:8181', { pk: 'B62test', sk: 'EKFtest' });
  });

  test('releases the acquired account when the callback throws', async () => {
    const release = mock(async () => {});

    await expect(
      withLightnetAccount(
        'http://127.0.0.1:8181',
        async () => {
          throw new Error('send failed');
        },
        {
          acquireLightnetAccount: async () => ({ pk: 'B62test', sk: 'EKFtest' }),
          releaseLightnetAccount: release,
        }
      )
    ).rejects.toThrow('send failed');

    expect(release).toHaveBeenCalledTimes(1);
  });

  test('wraps acquisition failures so callers can return 502', async () => {
    await expect(
      withLightnetAccount(
        'http://127.0.0.1:8181',
        async () => ({ ok: true }),
        {
          acquireLightnetAccount: async () => {
            throw new Error('Account manager returned invalid JSON');
          },
          releaseLightnetAccount: async () => {},
        }
      )
    ).rejects.toBeInstanceOf(LightnetAcquireError);
  });
});
