import { afterEach, describe, expect, it, mock } from 'bun:test';

// Bun shares one electron mock across test files, so every file's mock must
// export the same names (see auro-accounts.test.ts).
mock.module('electron', () => ({ app: { getPath: () => '/unused' }, ipcMain: {}, shell: {} }));
const { verifyEndpoints } = await import('../src/config-store.js');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface ProbeRequest {
  url: string;
  body: { query: string; variables?: { input?: {
    address?: string; tokenId?: string; from?: number; to?: number;
  } } };
}

function nodeReports(
  networkID: unknown,
  archive?: { body?: unknown; status?: number },
): ProbeRequest[] {
  const requests: ProbeRequest[] = [];
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body)) as ProbeRequest['body'];
    requests.push({ url: String(url), body });
    const isNode = body.query.includes('networkID');
    const response = isNode
      ? { data: { networkID } }
      : archive?.body ?? { data: {
        networkState: { maxBlockHeight: { pendingMaxBlockHeight: 100 } },
        events: [],
      } };
    return new Response(JSON.stringify(response), {
      status: isNode ? 200 : archive?.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return requests;
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

  it('accepts an explicitly reported devnet node in the shared test proof domain', async () => {
    nodeReports('mina:devnet');
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .resolves.toBe('devnet');
  });

  it('checks the archive pending tip and bounded event fields before accepting endpoints', async () => {
    const requests = nodeReports('mina:testnet');
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .resolves.toBe('testnet');

    const archive = requests.find((request) => request.url.includes(':8282'));
    expect(archive?.body.query).toContain('pendingMaxBlockHeight');
    expect(archive?.body.query).toContain('events(input: $input)');
    expect(archive?.body.query).toContain('authorizationKind');
    expect(archive?.body.variables?.input).toMatchObject({ from: 0, to: 1 });
    expect(archive?.body.variables?.input?.address).toStartWith('B62q');
    expect(archive?.body.variables?.input?.tokenId).toStartWith('wSHV');
  });

  it('accepts a decimal archive pending height', async () => {
    nodeReports('mina:testnet', { body: { data: {
      networkState: { maxBlockHeight: { pendingMaxBlockHeight: '100' } }, events: [],
    } } });
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .resolves.toBe('testnet');
  });

  for (const [name, height] of [
    ['missing', undefined], ['null', null], ['negative', -1],
    ['fractional', 1.5], ['nonnumeric', 'later'], ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    it(`rejects an archive pending height that is ${name}`, async () => {
      nodeReports('mina:testnet', { body: { data: {
        networkState: { maxBlockHeight: { pendingMaxBlockHeight: height } }, events: [],
      } } });
      await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
        .rejects.toThrow('valid pending block height');
    });
  }

  it('rejects an archive that does not return an events list', async () => {
    nodeReports('mina:testnet', { body: { data: {
      networkState: { maxBlockHeight: { pendingMaxBlockHeight: 100 } }, events: null,
    } } });
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .rejects.toThrow('bounded events list');
  });

  for (const field of ['to', 'authorizationKind']) {
    it(`rejects an archive that cannot query ${field}`, async () => {
      nodeReports('mina:testnet', { body: {
        data: { networkState: { maxBlockHeight: { pendingMaxBlockHeight: 100 } }, events: [] },
        errors: [{ message: `Unsupported ${field}` }],
      } });
      await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
        .rejects.toThrow(`Unsupported ${field}`);
    });
  }

  it('rejects a non-success archive HTTP response even if it contains GraphQL data', async () => {
    nodeReports('mina:testnet', { status: 502 });
    await expect(verifyEndpoints('http://localhost:8080/graphql', 'http://localhost:8282/graphql'))
      .rejects.toThrow('Archive endpoint returned HTTP 502');
  });
});
