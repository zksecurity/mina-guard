/**
 * The submissions route records a reported approve/execute tx hash, which
 * every owner's UI then treats as a transaction in flight. Anyone can call
 * it, so it must record only hashes the Mina node shows to be that action on
 * that proposal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { Field, PrivateKey, PublicKey } from 'o1js';
import { MinaGuard } from 'contracts';
import type { BackendConfig } from '../config.js';
import { prisma } from '../db.js';
import type { MinaGuardIndexer } from '../indexer.js';
import * as minaClient from '../mina-client.js';
import type { ZkappCommandUpdate } from '../mina-client.js';
import { createApiRouter } from '../routes.js';
import { LOOKUP_DELAYS_MS } from '../submission-check.js';

const VAULT = PrivateKey.random().toPublicKey().toBase58();
const CHILD = PrivateKey.random().toPublicKey().toBase58();
const OTHER = PrivateKey.random().toPublicKey().toBase58();
const PROPOSAL = '1234567890';
const OTHER_PROPOSAL = '987654321';
const TX = '5JtszX5pwB9SMZvwE16ZUxyWJAKLDfgGVzpAgpRHeFC3NDUC8FwQ';
const TX2 = '5Jtu6t2ysV88Wc65k6me6qMryEpacpr3ms98uLAJiLoup9ReSwgj';
const config = { minaEndpoint: 'http://node.invalid', minaFallbackEndpoint: null } as unknown as BackendConfig;

// Encode events the way o1js does: the sorted event-name index, then the fields.
const events = new MinaGuard(PublicKey.empty()).events as Record<string, { toFields(v: unknown): Field[] }>;
const names = Object.keys(events).sort();
function encode(type: 'approval' | 'execution', proposalHash: string): string[] {
  const value = type === 'approval'
    ? { proposalHash: Field(proposalHash), approver: PublicKey.fromBase58(OTHER), approvalCount: Field(2), approvalRoot: Field(0), voteNullifierRoot: Field(0) }
    : { proposalHash: Field(proposalHash), txType: Field(0), root: Field(0) };
  return [String(names.indexOf(type)), ...events[type].toFields(value).map(String)];
}
const update = (publicKey: string, isProved: boolean, ...evts: string[][]): ZkappCommandUpdate =>
  ({ publicKey, isProved, events: evts, stateConditions: [CURRENT[0], null, CURRENT[2]] });
const requiring = (u: ZkappCommandUpdate, stateConditions: Array<string | null>): ZkappCommandUpdate =>
  ({ ...u, stateConditions });
// Current app state of both the vault and the SubVault in these tests.
const CURRENT = ['11', '22', '33'];

let server: Server;
let baseUrl = '';
let lookups: ReturnType<typeof spyOn>;
const savedDelays = [...LOOKUP_DELAYS_MS];

function stubLookup(...responses: Array<ZkappCommandUpdate[] | null>) {
  let call = 0;
  lookups = spyOn(minaClient, 'fetchPooledZkappCommand').mockImplementation(
    async () => responses[Math.min(call++, responses.length - 1)],
  );
  spyOn(minaClient, 'fetchZkappStates').mockImplementation(
    async (_config, addresses) => new Map(addresses.map((a) => [a, CURRENT])),
  );
}

async function post(body: unknown, proposalHash = PROPOSAL) {
  const res = await fetch(`${baseUrl}/api/contracts/${VAULT}/proposals/${proposalHash}/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function stored() {
  return prisma.proposal.findFirstOrThrow({ where: { proposalHash: PROPOSAL } });
}

function startServer(cfg?: BackendConfig): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(createApiRouter({} as MinaGuardIndexer, cfg));
  const s = app.listen(0);
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.once('listening', () => {
      const address = s.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      resolve({ server: s, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function clearDatabase() {
  await prisma.eventRaw.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.contract.deleteMany();
}

beforeAll(async () => {
  ({ server, baseUrl } = await startServer(config));
  // One immediate lookup per check keeps the tests fast; the retry test sets its own.
  LOOKUP_DELAYS_MS.splice(0, LOOKUP_DELAYS_MS.length, 0);
});

beforeEach(async () => {
  await clearDatabase();
  const contract = await prisma.contract.create({ data: { address: VAULT, ready: true, permissionsVerified: true } });
  await prisma.proposal.create({
    data: {
      contractId: contract.id, proposalHash: PROPOSAL, createdAtBlock: 1,
      childAccount: CHILD, destination: 'remote', lastApproveError: 'old failure',
    },
  });
});

afterEach(() => {
  mock.restore();
  LOOKUP_DELAYS_MS.splice(0, LOOKUP_DELAYS_MS.length, 0);
});

afterAll(async () => {
  LOOKUP_DELAYS_MS.splice(0, LOOKUP_DELAYS_MS.length, ...savedDelays);
  server.close();
  await clearDatabase();
  await prisma.$disconnect();
});

describe('submission reports', () => {
  test('records a real approval of this proposal and clears the old error', async () => {
    stubLookup([update(OTHER, false), update(VAULT, true, encode('approval', PROPOSAL))]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(200);
    const row = await stored();
    expect(row.lastApproveTxHash).toBe(TX);
    expect(row.lastApproveError).toBeNull();
  });

  test('refuses a hash the node does not know, and records nothing', async () => {
    stubLookup(null);
    const res = await post({ action: 'approve', txHash: TX });
    expect(res.status).toBe(422);
    expect((await stored()).lastApproveTxHash).toBeNull();
  });

  test('refuses real transactions that are not this action on this proposal', async () => {
    const cases: ZkappCommandUpdate[][] = [
      [update(OTHER, true, encode('approval', PROPOSAL))], // another account
      [update(VAULT, false, encode('approval', PROPOSAL))], // event attached without a proof
      [update(VAULT, true, encode('approval', OTHER_PROPOSAL))], // another proposal
      [update(VAULT, true, encode('execution', PROPOSAL))], // another action
      [update(VAULT, true)], // no event at all
    ];
    for (const updates of cases) {
      stubLookup(updates);
      expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
      mock.restore();
    }
    expect((await stored()).lastApproveTxHash).toBeNull();
  });

  test('does not lock on an approval the indexer has already applied', async () => {
    const row = await stored();
    await prisma.eventRaw.create({
      data: { contractId: row.contractId, blockHeight: 2, txHash: TX, eventType: 'approval', payload: '{}', fingerprint: `approval-${TX}` },
    });
    stubLookup([update(VAULT, true, encode('approval', PROPOSAL))]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(200);
    expect((await stored()).lastApproveTxHash).toBeNull();
  });

  test('refuses a proof built on state the vault does not have', async () => {
    // A made-up owner list, or a transaction already in a block: both require
    // a state the vault no longer (or never) had.
    stubLookup([requiring(update(VAULT, true, encode('approval', PROPOSAL)), ['99', null, CURRENT[2]])]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
    expect((await stored()).lastApproveTxHash).toBeNull();
  });

  test('ignores state slots the update leaves open, and decimal formatting', async () => {
    stubLookup([requiring(update(VAULT, true, encode('approval', PROPOSAL)), [null, '022', null, null])]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(200);
  });

  test('refuses a required slot beyond the account state, or a missing account', async () => {
    stubLookup([requiring(update(VAULT, true, encode('approval', PROPOSAL)), [null, null, null, '0'])]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
    mock.restore();
    stubLookup([update(VAULT, true, encode('approval', PROPOSAL))]);
    spyOn(minaClient, 'fetchZkappStates').mockResolvedValue(new Map([[VAULT, null]]));
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
  });

  test('refuses when the state lookup fails, after retrying it', async () => {
    stubLookup([update(VAULT, true, encode('approval', PROPOSAL))]);
    const states = spyOn(minaClient, 'fetchZkappStates').mockResolvedValue(null);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
    expect(states).toHaveBeenCalledTimes(1);

    LOOKUP_DELAYS_MS.splice(0, LOOKUP_DELAYS_MS.length, 0, 0);
    states.mockResolvedValueOnce(null).mockResolvedValue(new Map([[VAULT, CURRENT]]));
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(200);
    expect(states).toHaveBeenCalledTimes(3);
  });

  test('refuses an update whose state conditions the node did not report', async () => {
    stubLookup([{ ...update(VAULT, true, encode('approval', PROPOSAL)), stateConditions: null }]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
    expect((await stored()).lastApproveTxHash).toBeNull();
  });

  test('a remote execution also needs the vault update to require current state', async () => {
    stubLookup([
      requiring(update(VAULT, false), ['99', null, null]),
      update(CHILD, true, encode('execution', PROPOSAL)),
    ]);
    expect((await post({ action: 'execute', txHash: TX })).status).toBe(422);
  });

  test('accepts a remote execution whose event the SubVault emits', async () => {
    stubLookup([update(VAULT, false), update(CHILD, true, encode('execution', PROPOSAL))]);
    expect((await post({ action: 'execute', txHash: TX })).status).toBe(200);
    expect((await stored()).lastExecuteTxHash).toBe(TX);
  });

  test('does not accept a SubVault event for an approval', async () => {
    stubLookup([update(CHILD, true, encode('approval', PROPOSAL))]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(422);
  });

  test('a repeated report changes nothing and asks the node nothing', async () => {
    stubLookup([update(VAULT, true, encode('approval', PROPOSAL))]);
    await post({ action: 'approve', txHash: TX });
    const before = await stored();
    const calls = lookups.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(200);
    expect(lookups.mock.calls.length).toBe(calls);
    expect((await stored()).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  test('waits for a transaction that reaches the node a little late', async () => {
    LOOKUP_DELAYS_MS.splice(0, LOOKUP_DELAYS_MS.length, 0, 1, 1);
    stubLookup(null, null, [update(VAULT, true, encode('approval', PROPOSAL))]);
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(200);
    expect(lookups.mock.calls.length).toBe(3);
  });

  test('rejects malformed hashes without asking the node', async () => {
    stubLookup(null);
    for (const txHash of ['', 'not a hash', '0OIl'.repeat(13), `${TX}"`]) {
      expect((await post({ action: 'approve', txHash })).status).toBe(400);
    }
    expect(lookups.mock.calls.length).toBe(0);
  });

  test('caps concurrent checks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    lookups = spyOn(minaClient, 'fetchPooledZkappCommand').mockImplementation(async () => {
      await gate;
      return null;
    });
    const pending = Array.from({ length: 8 }, () => post({ action: 'approve', txHash: TX2 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await post({ action: 'approve', txHash: TX })).status).toBe(429);
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(8).fill(422));
  });

  test('refuses reports when the router has no node to check with', async () => {
    const bare = await startServer(undefined);
    const res = await fetch(`${bare.baseUrl}/api/contracts/${VAULT}/proposals/${PROPOSAL}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', txHash: TX }),
    });
    bare.server.close();
    expect(res.status).toBe(503);
    expect((await stored()).lastApproveTxHash).toBeNull();
  });
});
