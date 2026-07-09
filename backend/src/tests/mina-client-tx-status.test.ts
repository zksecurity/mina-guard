import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { BackendConfig } from '../config.js';
import { fetchZkappTxStatus } from '../mina-client.js';

const config = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
} as unknown as BackendConfig;

/** Minimal Response-shaped stub for the global fetch mock. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore();
});

describe('fetchZkappTxStatus: distinguishes lookup failure from confirmed-absent', () => {
  // Regression: a failed lookup must report 'unknown', NOT 'pending'. Masking it
  // as 'pending' let the dropped-tx check treat an undetermined (possibly
  // included) tx as confirmed-absent from the chain.
  test("returns 'unknown' when the request rejects (network error)", async () => {
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchZkappTxStatus(config, 'tx-1');
    expect(result.status).toBe('unknown');
  });

  test("returns 'unknown' on an upstream 5xx", async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(null, 502));
    const result = await fetchZkappTxStatus(config, 'tx-1');
    expect(result.status).toBe('unknown');
  });

  test("returns 'unknown' on a GraphQL error payload", async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ errors: [{ message: 'boom' }] }),
    );
    const result = await fetchZkappTxStatus(config, 'tx-1');
    expect(result.status).toBe('unknown');
  });

  // Control: a successful scan that doesn't contain the tx is a *positive*
  // 'pending' — this is what must stay distinct from 'unknown' above.
  test("returns 'pending' when the scan succeeds but the tx is absent", async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { bestChain: [] } }),
    );
    const result = await fetchZkappTxStatus(config, 'tx-1');
    expect(result.status).toBe('pending');
  });
});
