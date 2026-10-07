import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { BackendConfig } from '../config.js';
import { fetchPooledZkappCommand, fetchZkappStates } from '../mina-client.js';

const config = {
  minaEndpoint: 'http://stub',
  minaFallbackEndpoint: null,
} as unknown as BackendConfig;

const TX = '5JtszX5pwB9SMZvwE16ZUxyWJAKLDfgGVzpAgpRHeFC3NDUC8FwQ';
const VAULT = 'B62qqFKVtPsNJZsGx5Bv1Bc4cyMnK3t9BMqQoahqHoJErp6bMhAmFPp';
const OTHER = 'B62qoG5Yk4iVxpyczUrBNpwtx2xunhL48dydN53A2VjoRwF8NUjtL3';

/** Minimal Response-shaped stub for the global fetch mock. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

const requestBody = (spy: ReturnType<typeof spyOn>, call = 0) =>
  JSON.parse(String((spy.mock.calls[call][1] as RequestInit).body));

// Shaped like the daemon's answer (devnet, 2026-10-05).
const command = (hash: string) => ({
  hash,
  zkappCommand: { accountUpdates: [
    { body: { publicKey: 'B62qfeepayer', events: [], authorizationKind: { isProved: false },
      preconditions: { account: { state: [null, null] } } } },
    { body: { publicKey: VAULT, events: [['13', '0', '0']], authorizationKind: { isProved: true },
      preconditions: { account: { state: ['7', null] } } } },
    { body: { publicKey: OTHER, events: [], authorizationKind: { isProved: true } } },
  ] },
});

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore();
});

describe('fetchPooledZkappCommand', () => {
  test('finds a pooled command and reports each update with its state conditions', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { pooledZkappCommands: [command('5Jother'), command(TX)] } }),
    );
    expect(await fetchPooledZkappCommand(config, TX)).toEqual([
      { publicKey: 'B62qfeepayer', isProved: false, events: [], stateConditions: [null, null] },
      { publicKey: VAULT, isProved: true, events: [['13', '0', '0']], stateConditions: ['7', null] },
      // No reported conditions is not the same as no conditions.
      { publicKey: OTHER, isProved: true, events: [], stateConditions: null },
    ]);
    expect(requestBody(fetchSpy).variables).toEqual({ hashes: [TX] });
    // Bounded, so a hung node cannot hold a check slot.
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  test('returns null when the pool does not hold the hash or the node cannot answer', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: { pooledZkappCommands: [command('5Jother')] } }));
    expect(await fetchPooledZkappCommand(config, TX)).toBeNull();

    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchPooledZkappCommand(config, TX)).toBeNull();
  });
});

describe('fetchZkappStates', () => {
  test('maps each address to its state, and a missing account to null', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { a0: { zkappState: ['7', '0'] }, a1: null } }),
    );
    const states = await fetchZkappStates(config, [VAULT, OTHER]);
    expect(states?.get(VAULT)).toEqual(['7', '0']);
    expect(states?.get(OTHER)).toBeNull();
    expect(requestBody(fetchSpy).variables).toEqual({ a0: VAULT, a1: OTHER });
  });

  test('returns null when the node cannot answer', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ errors: [{ message: 'boom' }] }));
    expect(await fetchZkappStates(config, [VAULT])).toBeNull();
  });
});
