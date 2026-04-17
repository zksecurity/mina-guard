import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { PrivateKey } from 'o1js';
import { prisma } from '../db.js';
import type { MinaGuardIndexer } from '../indexer.js';
import { createApiRouter } from '../routes.js';

let server: Server;
let baseUrl = '';

const contractAddress = PrivateKey.random().toPublicKey().toBase58();
const otherContractAddress = PrivateKey.random().toPublicKey().toBase58();
const childOneAddress = PrivateKey.random().toPublicKey().toBase58();
const childTwoAddress = PrivateKey.random().toPublicKey().toBase58();
const ownerA = PrivateKey.random().toPublicKey().toBase58();
const ownerB = PrivateKey.random().toPublicKey().toBase58();
const ownerC = PrivateKey.random().toPublicKey().toBase58();

const proposalHashA = '101';
const proposalHashB = '202';
const proposalHashC = '303';
const otherProposalHash = '404';
// REMOTE child-lifecycle proposal targeting childOne — exercises destination/childAccount.
const remoteProposalHash = '505';

function get(path: string) {
  return fetch(`${baseUrl}${path}`);
}

async function clearDatabase() {
  await prisma.approval.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.owner.deleteMany();
  await prisma.contract.deleteMany();
}

async function seedDatabase() {
  await prisma.contract.createMany({
    data: [
      { address: contractAddress, networkId: '1' },
      { address: otherContractAddress, networkId: '1' },
      // Two subaccounts of `contractAddress`. childTwo has multi-sig disabled
      // (e.g. after a destroy) so the API exposes both states.
      { address: childOneAddress, networkId: '1', parent: contractAddress, childMultiSigEnabled: true },
      { address: childTwoAddress, networkId: '1', parent: contractAddress, childMultiSigEnabled: false },
    ],
  });

  const contract = await prisma.contract.findUniqueOrThrow({
    where: { address: contractAddress },
  });
  const otherContract = await prisma.contract.findUniqueOrThrow({
    where: { address: otherContractAddress },
  });

  await prisma.owner.createMany({
    data: [
      { contractId: contract.id, address: ownerA, index: 0, active: true },
      { contractId: contract.id, address: ownerB, index: 1, active: false },
      { contractId: otherContract.id, address: ownerC, index: 0, active: true },
    ],
  });

  await prisma.proposal.createMany({
    data: [
      {
        contractId: contract.id,
        proposalHash: proposalHashA,
        status: 'pending',
        createdAtBlock: 10,
      },
      {
        contractId: contract.id,
        proposalHash: proposalHashB,
        status: 'executed',
        createdAtBlock: 20,
      },
      {
        contractId: contract.id,
        proposalHash: proposalHashC,
        status: 'pending',
        createdAtBlock: 30,
      },
      {
        contractId: otherContract.id,
        proposalHash: otherProposalHash,
        status: 'pending',
        createdAtBlock: 40,
      },
      // REMOTE child-lifecycle proposal on the parent, targeting childOne.
      {
        contractId: contract.id,
        proposalHash: remoteProposalHash,
        status: 'pending',
        createdAtBlock: 50,
        destination: 'remote',
        childAccount: childOneAddress,
        txType: '7', // RECLAIM_CHILD
      },
    ],
  });

  await prisma.eventRaw.createMany({
    data: [
      {
        contractId: contract.id,
        blockHeight: 5,
        eventType: 'setup',
        payload: '{}',
        fingerprint: 'routes-event-a',
      },
      {
        contractId: contract.id,
        blockHeight: 10,
        eventType: 'proposal',
        payload: '{}',
        fingerprint: 'routes-event-b',
      },
      {
        contractId: contract.id,
        blockHeight: 15,
        eventType: 'approval',
        payload: '{}',
        fingerprint: 'routes-event-c',
      },
      {
        contractId: otherContract.id,
        blockHeight: 25,
        eventType: 'setup',
        payload: '{}',
        fingerprint: 'routes-event-d',
      },
    ],
  });
}

beforeAll(async () => {
  await clearDatabase();
  await seedDatabase();

  const indexer = {
    getStatus: () => ({
      running: false,
      lastRunAt: null,
      lastSuccessfulRunAt: null,
      latestChainHeight: 0,
      indexedHeight: 0,
      lastError: null,
      discoveredContracts: 4,
    }),
  } as unknown as MinaGuardIndexer;

  const app = express();
  app.use(express.json());
  app.use(createApiRouter(indexer));
  server = app.listen(0);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not expose a numeric port'));
        return;
      }

      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  await clearDatabase();
  await prisma.$disconnect();
});

describe('route param validation', () => {
  test('rejects invalid contract address', async () => {
    const res = await get('/api/contracts/not-a-valid-address');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid contract address');
  });

  test('rejects invalid proposal hash', async () => {
    const res = await get(`/api/contracts/${contractAddress}/proposals/not-a-valid-hash/approvals`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid proposal hash');
  });
});

describe('GET /api/contracts/:address/owners', () => {
  test('filters active owners when active=true', async () => {
    const res = await get(`/api/contracts/${contractAddress}/owners?active=true`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].address).toBe(ownerA);
  });

  test('filters inactive owners when active=false', async () => {
    const res = await get(`/api/contracts/${contractAddress}/owners?active=false`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].address).toBe(ownerB);
  });

  test('ignores non-boolean active values', async () => {
    const res = await get(`/api/contracts/${contractAddress}/owners?active=maybe`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });
});

describe('GET /api/contracts/:address/proposals', () => {
  test('defaults query values when limit and offset are invalid', async () => {
    const res = await get(`/api/contracts/${contractAddress}/proposals?limit=nope&offset=nope`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(4);
    expect(body.map((proposal: { proposalHash: string }) => proposal.proposalHash)).toEqual([
      remoteProposalHash,
      proposalHashC,
      proposalHashB,
      proposalHashA,
    ]);
  });

  test('clamps numeric limit and offset values', async () => {
    const res = await get(`/api/contracts/${contractAddress}/proposals?limit=0&offset=-4`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].proposalHash).toBe(remoteProposalHash);
  });

  test('treats empty status as missing and non-empty status as filter', async () => {
    const emptyStatusRes = await get(`/api/contracts/${contractAddress}/proposals?status=`);
    expect(emptyStatusRes.status).toBe(200);
    const emptyStatusBody = await emptyStatusRes.json();
    expect(emptyStatusBody).toHaveLength(4);

    const filteredRes = await get(`/api/contracts/${contractAddress}/proposals?status=pending`);
    expect(filteredRes.status).toBe(200);
    const filteredBody = await filteredRes.json();
    expect(filteredBody).toHaveLength(3);
    expect(filteredBody.every((proposal: { status: string }) => proposal.status === 'pending')).toBe(true);
  });

  test('exposes destination and childAccount on REMOTE proposals', async () => {
    const res = await get(`/api/contracts/${contractAddress}/proposals/${remoteProposalHash}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposalHash).toBe(remoteProposalHash);
    expect(body.destination).toBe('remote');
    expect(body.childAccount).toBe(childOneAddress);
  });

  test('LOCAL proposals leave destination and childAccount null', async () => {
    const res = await get(`/api/contracts/${contractAddress}/proposals/${proposalHashA}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.destination).toBeNull();
    expect(body.childAccount).toBeNull();
  });
});

describe('GET /api/contracts/:address (subaccount fields)', () => {
  test('exposes parent and childMultiSigEnabled on child contracts', async () => {
    const res = await get(`/api/contracts/${childOneAddress}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(childOneAddress);
    expect(body.parent).toBe(contractAddress);
    expect(body.childMultiSigEnabled).toBe(true);
  });

  test('reports childMultiSigEnabled=false for destroyed/disabled children', async () => {
    const res = await get(`/api/contracts/${childTwoAddress}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parent).toBe(contractAddress);
    expect(body.childMultiSigEnabled).toBe(false);
  });

  test('parent is null on root contracts', async () => {
    const res = await get(`/api/contracts/${contractAddress}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parent).toBeNull();
  });
});

describe('GET /api/contracts/:address/children', () => {
  test('lists subaccounts whose parent matches the requested address', async () => {
    const res = await get(`/api/contracts/${contractAddress}/children`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    const addresses = body.map((c: { address: string }) => c.address).sort();
    expect(addresses).toEqual([childOneAddress, childTwoAddress].sort());
  });

  test('returns an empty array for a contract with no subaccounts', async () => {
    const res = await get(`/api/contracts/${otherContractAddress}/children`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test('returns an empty array even when the address is unknown', async () => {
    const unknown = PrivateKey.random().toPublicKey().toBase58();
    const res = await get(`/api/contracts/${unknown}/children`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe('GET /api/contracts/:address/events', () => {
  test('defaults invalid filters and clamps pagination', async () => {
    const res = await get(
      `/api/contracts/${contractAddress}/events?fromBlock=bad&toBlock=10.9&limit=999&offset=-5`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.map((event: { blockHeight: number }) => event.blockHeight)).toEqual([10, 5]);
  });

  test('floors numeric block filters', async () => {
    const res = await get(
      `/api/contracts/${contractAddress}/events?fromBlock=9.8&toBlock=14.2&limit=5&offset=0`
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].blockHeight).toBe(10);
  });
});
