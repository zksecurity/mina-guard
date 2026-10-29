import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { BackendConfig } from '../config.js';
import { fetchLatestBlockHeight } from '../mina-client.js';

const config = {
  minaEndpoint: 'http://daemon.example/graphql',
  minaFallbackEndpoint: null,
  archiveEndpoint: 'http://archive.example/',
  archiveFallbackEndpoint: null,
} as BackendConfig;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore();
});

describe('archive event cursor height', () => {
  test('uses the archive pending tip when the daemon is ahead', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: { networkState: { maxBlockHeight: { pendingMaxBlockHeight: 100 } } },
    }));

    expect(await fetchLatestBlockHeight(config)).toBe(100);
    expect(fetchSpy.mock.calls[0][0]).toBe(config.archiveEndpoint);
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).query)
      .toContain('pendingMaxBlockHeight');
  });

  test('fails closed when archive networkState cannot answer', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: null,
      errors: [{ message: 'Unexpected error.' }],
    }));
    await expect(fetchLatestBlockHeight(config)).rejects.toThrow('Unexpected error.');
  });

  test('does not treat a missing archive height as block zero', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: { networkState: { maxBlockHeight: { pendingMaxBlockHeight: null } } },
    }));
    await expect(fetchLatestBlockHeight(config)).rejects.toThrow('pendingMaxBlockHeight');
  });
});
