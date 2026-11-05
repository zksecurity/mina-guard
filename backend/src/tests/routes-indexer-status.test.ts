/**
 * GET /api/indexer/status is public. The message of a failed tick can name
 * database hosts, connection strings or file paths, so the route publishes
 * only that the last tick failed and when; the message stays in the server
 * log.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { BackendConfig } from '../config.js';
import { toPublicIndexerStatus, type IndexerStatus, type MinaGuardIndexer } from '../indexer.js';
import { createApiRouter } from '../routes.js';

const SECRET = "Can't reach database server at `db.internal.example:5432` (postgresql://indexer:hunter2@db.internal.example/minaguard)";

const status: Omit<IndexerStatus, 'indexerMode'> = {
  running: true,
  lastRunAt: '2026-07-01T12:00:30.000Z',
  lastSuccessfulRunAt: '2026-07-01T12:00:00.000Z',
  latestChainHeight: 1000,
  latestSlot: 2000,
  indexedHeight: 990,
  lastError: SECRET,
  lastErrorAt: '2026-07-01T12:00:30.000Z',
  lastWarning: null,
  discoveredContracts: 3,
  firstScans: [],
};

const indexer = { getStatus: () => ({ ...status }) } as unknown as MinaGuardIndexer;
const config = { indexerMode: 'lite' } as unknown as BackendConfig;

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
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

afterAll(() => {
  server.close();
});

describe('GET /api/indexer/status', () => {
  test('reports a failed tick without its error text', async () => {
    const res = await fetch(`${baseUrl}/api/indexer/status`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('db.internal.example');
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({
      running: true,
      lastRunAt: '2026-07-01T12:00:30.000Z',
      lastSuccessfulRunAt: '2026-07-01T12:00:00.000Z',
      latestChainHeight: 1000,
      latestSlot: 2000,
      indexedHeight: 990,
      lastRunFailed: true,
      lastErrorAt: '2026-07-01T12:00:30.000Z',
      lastWarning: null,
      discoveredContracts: 3,
      firstScans: [],
      indexerMode: 'lite',
    });
  });

  test('a healthy indexer reports no failure', () => {
    const healthy = toPublicIndexerStatus({ ...status, lastError: null, lastErrorAt: null });
    expect(healthy).not.toHaveProperty('lastError');
    expect(healthy).toMatchObject({ lastRunFailed: false, lastErrorAt: null });
  });
});
