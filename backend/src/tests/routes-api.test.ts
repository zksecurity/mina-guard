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
// Dedicated contract (and child) for invalidation-state tests — kept
// isolated from the main test contract so its fixed proposal counts aren't
// disturbed.
const invalidStateContractAddress = PrivateKey.random().toPublicKey().toBase58();
const invalidStateChildAddress = PrivateKey.random().toPublicKey().toBase58();
const ownerA = PrivateKey.random().toPublicKey().toBase58();
const ownerB = PrivateKey.random().toPublicKey().toBase58();
const ownerC = PrivateKey.random().toPublicKey().toBase58();

const proposalHashA = '101';
const proposalHashB = '202';
const proposalHashC = '303';
const otherProposalHash = '404';
// REMOTE child-lifecycle proposal targeting childOne — exercises destination/childAccount.
const remoteProposalHash = '505';
// Proposals on invalidStateContract used to validate status=invalidated:
//   configStaleHash — configNonce behind contract (should be config_nonce_stale)
//   localStaleHash  — nonce behind parent.nonce (should be proposal_nonce_stale)
//   remoteStaleHash — REMOTE w/ nonce behind child.parentNonce
//   createChildHash — CREATE_CHILD (txType=5) nonce=0; always pending
//   freshHash       — config+nonce fresh, stays pending
const configStaleHash = '601';
const localStaleHash = '602';
const remoteStaleHash = '603';
const createChildHash = '604';
const freshHash = '605';

function get(path: string) {
  return fetch(`${baseUrl}${path}`);
}

async function clearDatabase() {
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.contract.deleteMany();
}

async function seedDatabase() {
  await prisma.contract.createMany({
    data: [
      { address: contractAddress, ready: true },
      { address: otherContractAddress, ready: true },
      // Two subaccounts of `contractAddress`. childTwo has multi-sig disabled
      // (e.g. after a destroy) so the API exposes both states.
      { address: childOneAddress, parent: contractAddress, ready: true },
      { address: childTwoAddress, parent: contractAddress, ready: true },
      { address: invalidStateContractAddress, ready: true },
      { address: invalidStateChildAddress, parent: invalidStateContractAddress, ready: true },
    ],
  });

  const contract = await prisma.contract.findUniqueOrThrow({
    where: { address: contractAddress },
  });
  const otherContract = await prisma.contract.findUniqueOrThrow({
    where: { address: otherContractAddress },
  });
  const childOne = await prisma.contract.findUniqueOrThrow({
    where: { address: childOneAddress },
  });
  const childTwo = await prisma.contract.findUniqueOrThrow({
    where: { address: childTwoAddress },
  });

  // Seed explicit nonces so tests asserting proposal status are robust
  // against future changes to null-handling in deriveInvalidReason.
  // `contract` (parent): nonce=0 (no local proposals executed yet),
  // configNonce=0. Children's `parentNonce=0` means a REMOTE proposal with
  // nonce>0 is not parent-nonce-stale.
  await prisma.contractConfig.createMany({
    data: [
      { contractId: contract.id, validFromBlock: 5, networkId: '1', childMultiSigEnabled: true, nonce: 0, parentNonce: 0, configNonce: 0 },
      { contractId: otherContract.id, validFromBlock: 25, networkId: '1', childMultiSigEnabled: true, nonce: 0, parentNonce: 0, configNonce: 0 },
      { contractId: childOne.id, validFromBlock: 5, networkId: '1', childMultiSigEnabled: true, nonce: 0, parentNonce: 0, configNonce: 0 },
      { contractId: childTwo.id, validFromBlock: 5, networkId: '1', childMultiSigEnabled: false, nonce: 0, parentNonce: 0, configNonce: 0 },
    ],
  });

  // OwnerMembership history: ownerA added, ownerB added then removed. Latest
  // action per address determines current active state.
  await prisma.ownerMembership.createMany({
    data: [
      { contractId: contract.id, address: ownerA, action: 'added', index: 0, validFromBlock: 5 },
      { contractId: contract.id, address: ownerB, action: 'added', index: 1, validFromBlock: 5 },
      { contractId: contract.id, address: ownerB, action: 'removed', index: 1, validFromBlock: 7, eventOrder: 1 },
      { contractId: otherContract.id, address: ownerC, action: 'added', index: 0, validFromBlock: 25 },
    ],
  });

  await prisma.proposal.createMany({
    data: [
      {
        contractId: contract.id,
        proposalHash: proposalHashA,
        createdAtBlock: 10,
      },
      {
        contractId: contract.id,
        proposalHash: proposalHashB,
        createdAtBlock: 20,
      },
      {
        contractId: contract.id,
        proposalHash: proposalHashC,
        createdAtBlock: 30,
      },
      {
        contractId: otherContract.id,
        proposalHash: otherProposalHash,
        createdAtBlock: 40,
      },
      // REMOTE child-lifecycle proposal on the parent, targeting childOne.
      {
        contractId: contract.id,
        proposalHash: remoteProposalHash,
        createdAtBlock: 50,
        destination: 'remote',
        childAccount: childOneAddress,
        txType: '7', // RECLAIM_CHILD
      },
    ],
  });

  const executedProposal = await prisma.proposal.findUniqueOrThrow({
    where: { contractId_proposalHash: { contractId: contract.id, proposalHash: proposalHashB } },
    select: { id: true },
  });
  await prisma.proposalExecution.create({
    data: { proposalId: executedProposal.id, blockHeight: 22 },
  });

  // --- Invalidation fixtures ------------------------------------------------
  // A separate contract with nonce=5, configNonce=3 so proposals behind those
  // values show as invalidated. Its child has parentNonce=4, so REMOTE
  // proposals with nonce<=4 are parent-nonce-stale.
  const invalidContract = await prisma.contract.findUniqueOrThrow({
    where: { address: invalidStateContractAddress },
  });
  const invalidChild = await prisma.contract.findUniqueOrThrow({
    where: { address: invalidStateChildAddress },
  });

  await prisma.contractConfig.createMany({
    data: [
      {
        contractId: invalidContract.id,
        validFromBlock: 100,
        networkId: '1',
        childMultiSigEnabled: true,
        nonce: 5,
        parentNonce: 0,
        configNonce: 3,
      },
      {
        contractId: invalidChild.id,
        validFromBlock: 100,
        networkId: '1',
        childMultiSigEnabled: true,
        nonce: 0,
        parentNonce: 4,
        configNonce: 0,
      },
    ],
  });

  await prisma.proposal.createMany({
    data: [
      // config_nonce_stale: proposal.configNonce=1 < parent.configNonce=3
      {
        contractId: invalidContract.id,
        proposalHash: configStaleHash,
        createdAtBlock: 110,
        configNonce: '1',
        nonce: '10', // fresh enough on its own; config check wins
        destination: 'local',
      },
      // proposal_nonce_stale (LOCAL): nonce=5 <= parent.nonce=5
      {
        contractId: invalidContract.id,
        proposalHash: localStaleHash,
        createdAtBlock: 111,
        configNonce: '3',
        nonce: '5',
        destination: 'local',
      },
      // proposal_nonce_stale (REMOTE non-CREATE_CHILD): nonce=2 <= child.parentNonce=4
      {
        contractId: invalidContract.id,
        proposalHash: remoteStaleHash,
        createdAtBlock: 112,
        configNonce: '3',
        nonce: '2',
        destination: 'remote',
        childAccount: invalidStateChildAddress,
        txType: '7', // RECLAIM_CHILD
      },
      // CREATE_CHILD (txType=5): nonce=0 always, never nonce-stale
      {
        contractId: invalidContract.id,
        proposalHash: createChildHash,
        createdAtBlock: 113,
        configNonce: '3',
        nonce: '0',
        destination: 'remote',
        childAccount: invalidStateChildAddress,
        txType: '5',
      },
      // Fresh: nonce=6 > parent.nonce=5, configNonce=3 == parent.configNonce
      {
        contractId: invalidContract.id,
        proposalHash: freshHash,
        createdAtBlock: 114,
        configNonce: '3',
        nonce: '6',
        destination: 'local',
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

describe('proposal invalidation derivation', () => {
  type ProposalRow = {
    proposalHash: string;
    status: string;
    invalidReason: string | null;
  };

  async function getProposalsByContract(address: string): Promise<ProposalRow[]> {
    const res = await get(`/api/contracts/${address}/proposals`);
    expect(res.status).toBe(200);
    return res.json();
  }

  async function getProposalByHash(address: string, hash: string): Promise<ProposalRow> {
    const res = await get(`/api/contracts/${address}/proposals/${hash}`);
    expect(res.status).toBe(200);
    return res.json();
  }

  test('list endpoint marks config_nonce_stale proposal as invalidated', async () => {
    const body = await getProposalsByContract(invalidStateContractAddress);
    const configStale = body.find((p) => p.proposalHash === configStaleHash);
    expect(configStale).toBeDefined();
    expect(configStale?.status).toBe('invalidated');
    expect(configStale?.invalidReason).toBe('config_nonce_stale');
  });

  test('list endpoint marks LOCAL nonce-stale proposal as invalidated', async () => {
    const body = await getProposalsByContract(invalidStateContractAddress);
    const localStale = body.find((p) => p.proposalHash === localStaleHash);
    expect(localStale?.status).toBe('invalidated');
    expect(localStale?.invalidReason).toBe('proposal_nonce_stale');
  });

  test('list endpoint marks REMOTE parent-nonce-stale proposal as invalidated', async () => {
    const body = await getProposalsByContract(invalidStateContractAddress);
    const remoteStale = body.find((p) => p.proposalHash === remoteStaleHash);
    expect(remoteStale?.status).toBe('invalidated');
    expect(remoteStale?.invalidReason).toBe('proposal_nonce_stale');
  });

  test('CREATE_CHILD proposal stays pending even with nonce=0 (bypasses nonce check)', async () => {
    const body = await getProposalsByContract(invalidStateContractAddress);
    const createChild = body.find((p) => p.proposalHash === createChildHash);
    expect(createChild?.status).toBe('pending');
    expect(createChild?.invalidReason).toBeNull();
  });

  test('fresh proposal stays pending', async () => {
    const body = await getProposalsByContract(invalidStateContractAddress);
    const fresh = body.find((p) => p.proposalHash === freshHash);
    expect(fresh?.status).toBe('pending');
    expect(fresh?.invalidReason).toBeNull();
  });

  test('single-proposal endpoint reports invalidated status + reason', async () => {
    const body = await getProposalByHash(invalidStateContractAddress, configStaleHash);
    expect(body.status).toBe('invalidated');
    expect(body.invalidReason).toBe('config_nonce_stale');
  });

  test('?status=invalidated filter returns only invalidated proposals', async () => {
    const res = await get(
      `/api/contracts/${invalidStateContractAddress}/proposals?status=invalidated`
    );
    expect(res.status).toBe(200);
    const body: ProposalRow[] = await res.json();
    const hashes = body.map((p) => p.proposalHash).sort();
    expect(hashes).toEqual([configStaleHash, localStaleHash, remoteStaleHash].sort());
    expect(body.every((p) => p.status === 'invalidated')).toBe(true);
  });
});

describe('decorateContract exposes nonce + parentNonce', () => {
  test('GET /api/contracts/:address includes nonce and parentNonce from latest ContractConfig', async () => {
    const res = await get(`/api/contracts/${invalidStateContractAddress}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nonce).toBe(5);
    expect(body.parentNonce).toBe(0);
    expect(body.configNonce).toBe(3);
  });

  test('GET /api/contracts exposes nonce + parentNonce on each contract in the list', async () => {
    const res = await get(`/api/contracts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const entry = body.find((c: { address: string }) => c.address === invalidStateContractAddress);
    expect(entry).toBeDefined();
    expect(entry.nonce).toBe(5);
    expect(entry.parentNonce).toBe(0);
  });
});
