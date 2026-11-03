/**
 * GET /api/tx-status scans the Mina node's recent blocks for a transaction
 * hash. Anyone can call it, so it must refuse anything that is not a
 * transaction hash before it asks the node.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { BackendConfig } from '../config.js';
import type { MinaGuardIndexer } from '../indexer.js';
import * as minaClient from '../mina-client.js';
import { createApiRouter } from '../routes.js';

const config = { minaEndpoint: 'http://node.invalid', minaFallbackEndpoint: null } as unknown as BackendConfig;
const TX = '5JtszX5pwB9SMZvwE16ZUxyWJAKLDfgGVzpAgpRHeFC3NDUC8FwQ';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(createApiRouter({} as MinaGuardIndexer, config));
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  server.close();
});

function stubStatus() {
  return spyOn(minaClient, 'fetchZkappTxStatus').mockResolvedValue({ status: 'included' });
}

async function get(query: string) {
  const res = await fetch(`${baseUrl}/api/tx-status${query}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('GET /api/tx-status', () => {
  test('looks up a transaction hash', async () => {
    const lookup = stubStatus();
    expect(await get(`?hash=${TX}`)).toEqual({ status: 200, body: { status: 'included' } });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][1]).toBe(TX);
  });

  test('ignores spaces around the hash', async () => {
    const lookup = stubStatus();
    expect((await get(`?hash=%20${TX}%20`)).status).toBe(200);
    expect(lookup.mock.calls[0][1]).toBe(TX);
  });

  test('refuses anything that is not a transaction hash, without asking the node', async () => {
    const lookup = stubStatus();
    for (const hash of ['x', 'not%20a%20hash', '0OIl'.repeat(13), `${TX}%22`, `${TX}${'a'.repeat(20)}`]) {
      expect(await get(`?hash=${hash}`)).toEqual({ status: 400, body: { error: 'Invalid transaction hash' } });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  test('refuses a missing, empty, or repeated hash parameter', async () => {
    const lookup = stubStatus();
    for (const query of ['', '?hash=', `?hash=${TX}&hash=${TX}`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
