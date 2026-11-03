/**
 * When a route fails, the caller gets a fixed message. The error itself can
 * carry upstream GraphQL errors or internal host names, so it goes to the
 * server log only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import type { MinaGuardIndexer } from '../indexer.js';
import * as lightnet from '../lightnet.js';
import { createApiRouter } from '../routes.js';

const SECRET = 'GraphQL error from http://10.9.8.7:3085/graphql';
const config = {
  minaEndpoint: 'http://node.invalid',
  minaFallbackEndpoint: null,
  lightnetAccountManager: 'http://accounts.invalid',
} as unknown as BackendConfig;

const indexer = {
  getStatus() {
    throw new Error(SECRET);
  },
} as unknown as MinaGuardIndexer;

let server: Server;
let baseUrl = '';
let logged: ReturnType<typeof spyOn>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createApiRouter(indexer, config));
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

function captureLog() {
  logged = spyOn(console, 'error').mockImplementation(() => undefined);
}

function loggedText(): string {
  return logged.mock.calls.flat().map(String).join('\n');
}

describe('route failures', () => {
  test('a failed route answers 500 with a fixed message and logs the error', async () => {
    captureLog();
    const res = await fetch(`${baseUrl}/api/indexer/status`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('10.9.8.7');
    const body = JSON.parse(text) as { error: string; requestId: string };
    expect(body.error).toBe('Internal server error');
    expect(body.requestId).toMatch(/^[a-z0-9]+$/);
    expect(loggedText()).toContain(SECRET);
    expect(loggedText()).toContain(body.requestId);
  });

  test('a failed Lightnet funding request does not echo the upstream error', async () => {
    captureLog();
    spyOn(lightnet, 'acquireLightnetAccount').mockRejectedValue(new Error(SECRET));
    const res = await fetch(`${baseUrl}/api/fund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: PrivateKey.random().toPublicKey().toBase58() }),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain('10.9.8.7');
    expect(JSON.parse(text)).toEqual({ error: 'Failed to acquire funded account' });
    expect(loggedText()).toContain(SECRET);
  });
});
