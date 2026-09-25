import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('electron', () => ({ app: { getPath: () => '/unused' } }));
const { verifyEndpoints } = await import('../src/config-store.js');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function nodeReports(networkID: unknown) {
  globalThis.fetch = (async (_url, init) => {
    const query = JSON.parse(String(init?.body)).query as string;
    const data = query.includes('networkID') ? { networkID } : { __typename: 'Query' };
    return new Response(JSON.stringify({ data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('desktop endpoint network check', () => {
  it('rejects a mainnet node despite a testnet-looking URL', async () => {
    nodeReports('mina:mainnet');
    await expect(verifyEndpoints('https://testnet.example/graphql', 'https://archive.example/graphql'))
      .rejects.toThrow('Network mismatch');
  });

  it('rejects a node that omits networkID', async () => {
    nodeReports(undefined);
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .rejects.toThrow('networkID');
  });

  it('accepts an explicitly reported testnet node', async () => {
    nodeReports('mina:testnet');
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .resolves.toBe('testnet');
  });
});
