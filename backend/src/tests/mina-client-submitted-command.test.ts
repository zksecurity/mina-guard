import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { BackendConfig } from '../config.js';
import { fetchZkappCommandUpdates } from '../mina-client.js';

const config = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
} as unknown as BackendConfig;

const TX = '5JtszX5pwB9SMZvwE16ZUxyWJAKLDfgGVzpAgpRHeFC3NDUC8FwQ';
const VAULT = 'B62qqFKVtPsNJZsGx5Bv1Bc4cyMnK3t9BMqQoahqHoJErp6bMhAmFPp';

/** Minimal Response-shaped stub for the global fetch mock. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

// Shaped like the daemon's answer (devnet, 2026-10-05).
const command = (hash: string) => ({
  hash,
  zkappCommand: { accountUpdates: [
    { body: { publicKey: 'B62qfeepayer', events: [], authorizationKind: { isProved: false } } },
    { body: { publicKey: VAULT, events: [['13', '0', '0']], authorizationKind: { isProved: true } } },
  ] },
});

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore();
});

describe('fetchZkappCommandUpdates', () => {
  test('finds a pooled command and reports each update', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { pooledZkappCommands: [command(TX)], bestChain: [] } }),
    );
    expect(await fetchZkappCommandUpdates(config, TX)).toEqual([
      { publicKey: 'B62qfeepayer', isProved: false, events: [] },
      { publicKey: VAULT, isProved: true, events: [['13', '0', '0']] },
    ]);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.variables).toEqual({ hashes: [TX], maxLength: 20 });
  });

  test('finds an included command in a recent block', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: {
      pooledZkappCommands: [],
      bestChain: [{ transactions: { zkappCommands: [command('5Jother'), command(TX)] } }],
    } }));
    expect((await fetchZkappCommandUpdates(config, TX))?.[1].publicKey).toBe(VAULT);
  });

  test('returns null when the node does not know the hash or cannot answer', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: {
      pooledZkappCommands: [],
      bestChain: [{ transactions: { zkappCommands: [command('5Jother')] } }],
    } }));
    expect(await fetchZkappCommandUpdates(config, TX)).toBeNull();

    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchZkappCommandUpdates(config, TX)).toBeNull();
  });
});
