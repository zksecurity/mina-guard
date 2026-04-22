import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { PrivateKey } from 'o1js';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import type { MinaGuardIndexer } from '../indexer.js';
import * as minaClient from '../mina-client.js';
import { createApiRouter } from '../routes.js';

let server: Server;
let baseUrl = '';
let fullModeServer: Server;
let fullModeBaseUrl = '';

const subscribedAddress = PrivateKey.random().toPublicKey().toBase58();

const liteConfig = { indexerMode: 'lite' } as unknown as BackendConfig;
const fullConfig = { indexerMode: 'full' } as unknown as BackendConfig;

async function clearDatabase() {
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.blockHeader.deleteMany();
  await prisma.indexerCursor.deleteMany();
}

function buildStubIndexer(): MinaGuardIndexer {
  return {
    getStatus: () => ({
      running: false,
      lastRunAt: null,
      lastSuccessfulRunAt: null,
      latestChainHeight: 0,
      indexedHeight: 0,
      lastError: null,
      discoveredContracts: 0,
    }),
    // No-op backfill: the route should call it but tests don't need real syncing.
    backfillContract: async () => {},
  } as unknown as MinaGuardIndexer;
}

function startServer(cfg: BackendConfig): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(createApiRouter(buildStubIndexer(), cfg));
  const s = app.listen(0);

  return new Promise<{ server: Server; baseUrl: string }>((resolve, reject) => {
    s.once('error', reject);
    s.once('listening', () => {
      const address = s.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not expose a numeric port'));
        return;
      }
      resolve({ server: s, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

beforeAll(async () => {
  await clearDatabase();
  // Mock fetchLatestBlockHeight everywhere so subscribe doesn't hit a real node.
  mock.module('../mina-client.js', () => ({
    ...minaClient,
    fetchLatestBlockHeight: async () => 0,
  }));

  ({ server, baseUrl } = await startServer(liteConfig));
  ({ server: fullModeServer, baseUrl: fullModeBaseUrl } = await startServer(fullConfig));
});

afterEach(async () => {
  await clearDatabase();
  // Re-establish the baseline mock after any per-test overrides.
  mock.restore();
  mock.module('../mina-client.js', () => ({
    ...minaClient,
    fetchLatestBlockHeight: async () => 0,
  }));
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => server?.close(() => resolve())),
    new Promise<void>((resolve) => fullModeServer?.close(() => resolve())),
  ]);
  await prisma.$disconnect();
});

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

describe('POST /api/subscribe', () => {
  test('creates a contract entry when given a valid address', async () => {
    const res = await post('/api/subscribe', { address: subscribedAddress });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(subscribedAddress);

    const stored = await prisma.contract.findUnique({ where: { address: subscribedAddress } });
    expect(stored).not.toBeNull();
  });

  test('accepts addresses that are not yet deployed on-chain; row stays unready until events are ingested', async () => {
    // The subscribe route no longer performs a VK lookup, so a freshly
    // submitted deploy tx (still in the mempool) can be subscribed
    // immediately. The row should exist but remain hidden from API reads
    // via ready=false until syncSingleContract ingests an event.
    const res = await post('/api/subscribe', { address: subscribedAddress });

    expect(res.status).toBe(200);
    const stored = await prisma.contract.findUnique({ where: { address: subscribedAddress } });
    expect(stored).not.toBeNull();
    expect(stored?.ready).toBe(false);

    // And it is hidden from the contracts list endpoint.
    const listRes = await fetch(`${baseUrl}/api/contracts`);
    const body = (await listRes.json()) as Array<{ address: string }>;
    expect(body.map((c) => c.address)).not.toContain(subscribedAddress);
  });

  test('is idempotent when the contract is already tracked', async () => {
    await prisma.contract.create({ data: { address: subscribedAddress } });

    const res = await post('/api/subscribe', { address: subscribedAddress });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(subscribedAddress);

    const count = await prisma.contract.count({ where: { address: subscribedAddress } });
    expect(count).toBe(1);
  });

  test('rejects missing address', async () => {
    const res = await post('/api/subscribe', {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('address is required');
  });

  test('rejects invalid address', async () => {
    const res = await post('/api/subscribe', { address: 'not-a-valid-address' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid Mina public key');
  });
});

describe('DELETE /api/subscribe/:address', () => {
  test('removes the contract and cascades its related rows', async () => {
    const contract = await prisma.contract.create({
      data: { address: subscribedAddress, ready: true },
    });
    await prisma.contractConfig.create({
      data: { contractId: contract.id, validFromBlock: 1, networkId: '1' },
    });
    await prisma.ownerMembership.create({
      data: {
        contractId: contract.id,
        address: PrivateKey.random().toPublicKey().toBase58(),
        action: 'added',
        validFromBlock: 1,
      },
    });
    await prisma.eventRaw.create({
      data: {
        contractId: contract.id,
        blockHeight: 1,
        eventType: 'x',
        payload: '{}',
        fingerprint: `fp-${contract.id}`,
      },
    });

    const res = await del(`/api/subscribe/${subscribedAddress}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(await prisma.contract.findUnique({ where: { address: subscribedAddress } })).toBeNull();
    expect(await prisma.contractConfig.count({ where: { contractId: contract.id } })).toBe(0);
    expect(await prisma.ownerMembership.count({ where: { contractId: contract.id } })).toBe(0);
    expect(await prisma.eventRaw.count({ where: { contractId: contract.id } })).toBe(0);
  });

  test('returns 404 when the contract is not tracked', async () => {
    const res = await del(`/api/subscribe/${subscribedAddress}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Contract not found');
  });

  test('rejects invalid address in path', async () => {
    const res = await del('/api/subscribe/not-a-valid-address');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid contract address');
  });
});

describe('DELETE /api/subscribe/:address child cascade', () => {
  test('also deletes children and their related rows', async () => {
    const parent = await prisma.contract.create({
      data: { address: subscribedAddress, ready: true },
    });
    const childAddress = PrivateKey.random().toPublicKey().toBase58();
    const child = await prisma.contract.create({
      data: { address: childAddress, parent: subscribedAddress, ready: true },
    });

    await prisma.contractConfig.create({
      data: { contractId: child.id, validFromBlock: 2, networkId: '1' },
    });
    await prisma.eventRaw.create({
      data: {
        contractId: child.id,
        blockHeight: 2,
        eventType: 'x',
        payload: '{}',
        fingerprint: `fp-child-${child.id}`,
      },
    });

    const res = await del(`/api/subscribe/${subscribedAddress}`);
    expect(res.status).toBe(200);

    expect(await prisma.contract.findUnique({ where: { id: parent.id } })).toBeNull();
    expect(await prisma.contract.findUnique({ where: { id: child.id } })).toBeNull();
    expect(await prisma.contractConfig.count({ where: { contractId: child.id } })).toBe(0);
    expect(await prisma.eventRaw.count({ where: { contractId: child.id } })).toBe(0);
  });
});

describe('ready flag visibility', () => {
  test('GET /api/contracts hides unready rows', async () => {
    const readyAddress = PrivateKey.random().toPublicKey().toBase58();
    const unreadyAddress = PrivateKey.random().toPublicKey().toBase58();
    await prisma.contract.create({ data: { address: readyAddress, ready: true } });
    await prisma.contract.create({ data: { address: unreadyAddress, ready: false } });

    const res = await fetch(`${baseUrl}/api/contracts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ address: string }>;
    const addresses = body.map((c) => c.address);
    expect(addresses).toContain(readyAddress);
    expect(addresses).not.toContain(unreadyAddress);
  });

  test('GET /api/contracts/:address returns 404 for unready rows', async () => {
    const unreadyAddress = PrivateKey.random().toPublicKey().toBase58();
    await prisma.contract.create({ data: { address: unreadyAddress, ready: false } });

    const res = await fetch(`${baseUrl}/api/contracts/${unreadyAddress}`);
    expect(res.status).toBe(404);
  });

  test('GET /api/contracts/:parent/children hides unready children', async () => {
    const parentAddress = PrivateKey.random().toPublicKey().toBase58();
    const readyChild = PrivateKey.random().toPublicKey().toBase58();
    const unreadyChild = PrivateKey.random().toPublicKey().toBase58();

    await prisma.contract.create({ data: { address: parentAddress, ready: true } });
    await prisma.contract.create({
      data: { address: readyChild, parent: parentAddress, ready: true },
    });
    await prisma.contract.create({
      data: { address: unreadyChild, parent: parentAddress, ready: false },
    });

    const res = await fetch(`${baseUrl}/api/contracts/${parentAddress}/children`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ address: string }>;
    const addresses = body.map((c) => c.address);
    expect(addresses).toContain(readyChild);
    expect(addresses).not.toContain(unreadyChild);
  });
});

describe('full-mode gating', () => {
  test('POST /api/subscribe returns 404 in full mode', async () => {
    const res = await fetch(`${fullModeBaseUrl}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: subscribedAddress }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/lite mode/i);

    const stored = await prisma.contract.findUnique({ where: { address: subscribedAddress } });
    expect(stored).toBeNull();
  });

  test('DELETE /api/subscribe/:address returns 404 in full mode even when the contract exists', async () => {
    await prisma.contract.create({ data: { address: subscribedAddress } });

    const res = await fetch(`${fullModeBaseUrl}/api/subscribe/${subscribedAddress}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/lite mode/i);

    const stillThere = await prisma.contract.findUnique({ where: { address: subscribedAddress } });
    expect(stillThere).not.toBeNull();
  });
});
