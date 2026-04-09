import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Field, Mina, PrivateKey, PublicKey, Signature, UInt64, Bool, AccountUpdate } from 'o1js';
import express from 'express';
import type { Server } from 'http';
import { prisma } from '../db.js';
import { createBatchRouter } from '../batch-routes.js';
import { MinaGuardIndexer } from '../indexer.js';
import type { BackendConfig } from '../config.js';
import {
  Receiver, TransactionProposal, TxType, MinaGuard, SetupOwnersInput, MAX_OWNERS, MAX_RECEIVERS,
  computeOwnerChain, ApprovalStore, SignatureInputs, SignatureInput, SignatureOption, memoToField,
} from 'contracts';

let PORT: number;
let BASE: string;

let server: Server;

// Test keys — 3 owners, threshold 2, sorted by base58 for deterministic ordering
const owners = Array.from({ length: 3 }, () => {
  const key = PrivateKey.random();
  return { key, pub: key.toPublicKey() };
}).sort((a, b) => a.pub.toBase58() > b.pub.toBase58() ? 1 : -1);

const guardKey = PrivateKey.random();
const guardAddress = guardKey.toPublicKey();
const transferReceivers = [
  new Receiver({
    address: owners[0].pub,
    amount: UInt64.from(1_000_000_000),
  }),
];

const proposal = new TransactionProposal({
  receivers: [...transferReceivers, ...Array.from({ length: MAX_RECEIVERS - 1 }, () => Receiver.empty())],
  tokenId: Field(0),
  txType: TxType.TRANSFER,
  data: Field(0),
  memoHash: Field(0),
  uid: Field(42),
  configNonce: Field(0),
  expiryBlock: Field(0),
  networkId: Field(1),
  guardAddress,
});

const proposalHash = proposal.hash().toString();
const defaultProposer = owners[0].pub.toBase58();

/** Seed the DB with a contract and owners so routes can find them. */
async function seedDatabase() {
  await prisma.contract.create({
    data: {
      address: guardAddress.toBase58(),
      ownersCommitment: 'seeded',
      threshold: 2,
      numOwners: 3,
      configNonce: 0,
      networkId: '1',
    },
  });

  const contract = await prisma.contract.findUnique({
    where: { address: guardAddress.toBase58() },
  });

  for (let i = 0; i < owners.length; i++) {
    await prisma.owner.create({
      data: {
        contractId: contract!.id,
        address: owners[i].pub.toBase58(),
        index: i,
        active: true,
      },
    });
  }
}

async function clearDatabase() {
  await prisma.approval.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.owner.deleteMany();
  await prisma.contract.deleteMany();
}

function post(path: string, body: Record<string, unknown>) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(`${BASE}${path}`);
}

beforeAll(async () => {
  await clearDatabase();
  await seedDatabase();

  const app = express();
  app.use(express.json());
  app.use(createBatchRouter());
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('[test] route error:', err);
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  PORT = (server.address() as { port: number }).port;
  BASE = `http://localhost:${PORT}`;
});

afterAll(async () => {
  server?.close();
  await clearDatabase();
  await prisma.$disconnect();
});

describe('POST /api/contracts/:address/proposals', () => {
  test('rejects invalid contract address param', async () => {
    const res = await post('/api/contracts/not-a-valid-address/proposals', {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: guardAddress.toBase58(),
      proposalHash,
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid contract address');
  });

  test('creates an offchain proposal', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash,
      proposer: defaultProposer,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.proposalHash).toBe(proposalHash);
    expect(body.origin).toBe('offchain');
    expect(body.status).toBe('pending');
    expect(body.receivers).toEqual([{ index: 0, address: owners[0].pub.toBase58(), amount: '1000000000' }]);
    expect(body.recipientCount).toBe(1);
    expect(body.totalAmount).toBe('1000000000');
    expect(body.memo).toBeNull();
  });

  test('rejects duplicate proposal', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash,
      proposer: defaultProposer,
    });

    expect(res.status).toBe(409);
  });

  test('rejects mismatched proposal hash', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: '999999999',
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Proposal hash mismatch');
  });

  test('rejects addOwner proposals without toAddress', async () => {
    const addr = guardAddress.toBase58();
    const addOwnerProposal = new TransactionProposal({
      receivers: Array.from({ length: MAX_RECEIVERS }, () => Receiver.empty()),
      tokenId: Field(0),
      txType: TxType.ADD_OWNER,
      data: Field(123),
      memoHash: Field(0),
      uid: Field(88),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress,
    });

    const res = await post(`/api/contracts/${addr}/proposals`, {
      tokenId: '0',
      txType: TxType.ADD_OWNER.toString(),
      data: addOwnerProposal.data.toString(),
      memoHash: '0',
      uid: '88',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: addOwnerProposal.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Proposal toAddress is required for this transaction type');
  });

  test('rejects setDelegate proposals without toAddress when setting a delegate', async () => {
    const addr = guardAddress.toBase58();
    const delegateProposal = new TransactionProposal({
      receivers: Array.from({ length: MAX_RECEIVERS }, () => Receiver.empty()),
      tokenId: Field(0),
      txType: TxType.SET_DELEGATE,
      data: Field(1),
      memoHash: Field(0),
      uid: Field(89),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress,
    });

    const res = await post(`/api/contracts/${addr}/proposals`, {
      tokenId: '0',
      txType: TxType.SET_DELEGATE.toString(),
      data: '1',
      memoHash: '0',
      uid: '89',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: delegateProposal.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Proposal toAddress is required for this transaction type');
  });

  // --- memo field ---------------------------------------------------------

  /** Builds a fresh transfer proposal bound to a given memoHash for memo tests. */
  function buildMemoProposal(uid: number, memoHashField: ReturnType<typeof Field>) {
    return new TransactionProposal({
      receivers: [
        new Receiver({ address: owners[0].pub, amount: UInt64.from(1_000_000_000) }),
        ...Array.from({ length: MAX_RECEIVERS - 1 }, () => Receiver.empty()),
      ],
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      memoHash: memoHashField,
      uid: Field(uid),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress,
    });
  }

  test('accepts a proposal with a valid plaintext memo', async () => {
    const addr = guardAddress.toBase58();
    const memo = 'rent payment';
    const memoHash = memoToField(memo);
    const p = buildMemoProposal(201, memoHash);

    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memo,
      memoHash: memoHash.toString(),
      uid: '201',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: p.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.memo).toBe('rent payment');
  });

  test('accepts an omitted memo and defaults memoHash to Field(0)', async () => {
    const addr = guardAddress.toBase58();
    const p = buildMemoProposal(202, Field(0));

    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '202',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: p.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.memo).toBeNull();
  });

  test('rejects a memo exceeding 32 ASCII bytes', async () => {
    const addr = guardAddress.toBase58();
    const longMemo = 'a'.repeat(33);
    const memoHash = memoToField(longMemo);
    const p = buildMemoProposal(203, memoHash);

    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memo: longMemo,
      memoHash: memoHash.toString(),
      uid: '203',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: p.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request body');
    expect(body.details.memo).toBeDefined();
  });

  test('rejects a memo exceeding 32 bytes via multi-byte characters', async () => {
    const addr = guardAddress.toBase58();
    // 11 rocket emojis = 44 UTF-8 bytes but only 11 code points.
    const emojiMemo = '🚀'.repeat(11);
    const memoHash = memoToField(emojiMemo);
    const p = buildMemoProposal(204, memoHash);

    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memo: emojiMemo,
      memoHash: memoHash.toString(),
      uid: '204',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: p.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request body');
    expect(body.details.memo).toBeDefined();
  });

  test('rejects memoHash that does not match the plaintext memo', async () => {
    const addr = guardAddress.toBase58();
    // Client posts plaintext 'alice' but a memoHash computed from 'bob'.
    const spoofedMemoHash = memoToField('bob');
    const p = buildMemoProposal(205, spoofedMemoHash);

    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memo: 'alice',
      memoHash: spoofedMemoHash.toString(),
      uid: '205',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: p.hash().toString(),
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('memoHash does not match provided memo');
  });

  test('still catches a tampered proposal hash even when memo is valid', async () => {
    const addr = guardAddress.toBase58();
    const memo = 'valid memo';
    const memoHash = memoToField(memo);

    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '1000000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memo,
      memoHash: memoHash.toString(),
      uid: '206',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: '12345', // tampered
      proposer: defaultProposer,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Proposal hash mismatch');
  });
});

describe('POST /api/contracts/:address/proposals/:proposalHash/signatures', () => {
  test('rejects invalid proposal hash param', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals/not-a-valid-hash/signatures`, {
      signer: owners[0].pub.toBase58(),
      signatureR: '1',
      signatureS: '1',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid proposal hash');
  });

  test('accepts a valid signature from owner 0', async () => {
    const addr = guardAddress.toBase58();
    const sig = Signature.create(owners[0].key, [Field(proposalHash)]);
    const sigJson = sig.toJSON();

    const res = await post(`/api/contracts/${addr}/proposals/${proposalHash}/signatures`, {
      signer: owners[0].pub.toBase58(),
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.approvalCount).toBe(1);
    expect(body.threshold).toBe(2);
    expect(body.ready).toBe(false);
  });

  test('rejects duplicate signature', async () => {
    const addr = guardAddress.toBase58();
    const sig = Signature.create(owners[0].key, [Field(proposalHash)]);
    const sigJson = sig.toJSON();

    const res = await post(`/api/contracts/${addr}/proposals/${proposalHash}/signatures`, {
      signer: owners[0].pub.toBase58(),
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    expect(res.status).toBe(409);
  });

  test('rejects invalid signature', async () => {
    const addr = guardAddress.toBase58();
    // Sign with wrong key
    const wrongKey = PrivateKey.random();
    const sig = Signature.create(wrongKey, [Field(proposalHash)]);
    const sigJson = sig.toJSON();

    const res = await post(`/api/contracts/${addr}/proposals/${proposalHash}/signatures`, {
      signer: owners[1].pub.toBase58(),
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Signature verification failed');
  });

  test('rejects non-owner signer', async () => {
    const addr = guardAddress.toBase58();
    const randomKey = PrivateKey.random();
    const sig = Signature.create(randomKey, [Field(proposalHash)]);
    const sigJson = sig.toJSON();

    const res = await post(`/api/contracts/${addr}/proposals/${proposalHash}/signatures`, {
      signer: randomKey.toPublicKey().toBase58(),
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    expect(res.status).toBe(403);
  });

  test('accepts second signature and marks ready', async () => {
    const addr = guardAddress.toBase58();
    const sig = Signature.create(owners[1].key, [Field(proposalHash)]);
    const sigJson = sig.toJSON();

    const res = await post(`/api/contracts/${addr}/proposals/${proposalHash}/signatures`, {
      signer: owners[1].pub.toBase58(),
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.approvalCount).toBe(2);
    expect(body.threshold).toBe(2);
    expect(body.ready).toBe(true);
  });
});

describe('GET /api/contracts/:address/proposals/:proposalHash/batch-payload', () => {
  test('rejects invalid contract address param', async () => {
    const res = await get(`/api/contracts/not-a-valid-address/proposals/${proposalHash}/batch-payload`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid contract address');
  });

  test('rejects invalid proposal hash param', async () => {
    const addr = guardAddress.toBase58();
    const res = await get(`/api/contracts/${addr}/proposals/not-a-valid-hash/batch-payload`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid proposal hash');
  });

  test('returns ready payload with correct structure', async () => {
    const addr = guardAddress.toBase58();
    const res = await get(`/api/contracts/${addr}/proposals/${proposalHash}/batch-payload`);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ready).toBe(true);
    expect(body.threshold).toBe(2);
    expect(body.approvalCount).toBe(2);
    expect(body.inputs).toHaveLength(20);

    // First 3 slots are owners
    for (let i = 0; i < 3; i++) {
      expect(body.inputs[i].isSome).toBe(true);
      expect(body.inputs[i].signer).toBe(owners[i].pub.toBase58());
    }

    // Owner 0 and 1 signed
    expect(body.inputs[0].hasSignature).toBe(true);
    expect(body.inputs[0].signatureR).not.toBeNull();
    expect(body.inputs[1].hasSignature).toBe(true);
    expect(body.inputs[1].signatureR).not.toBeNull();

    // Owner 2 did not sign
    expect(body.inputs[2].hasSignature).toBe(false);
    expect(body.inputs[2].signatureR).toBeNull();

    // Remaining slots are empty
    for (let i = 3; i < 20; i++) {
      expect(body.inputs[i].isSome).toBe(false);
    }

    // Proposal data is included
    expect(body.proposal.proposalHash).toBe(proposalHash);
    expect(body.proposal.receivers).toEqual([{ index: 0, address: owners[0].pub.toBase58(), amount: '1000000000' }]);
    expect(body.proposal.totalAmount).toBe('1000000000');
  });

  test('orders payload owners by base58 address rather than persisted index', async () => {
    const contractAddress = PrivateKey.random().toPublicKey().toBase58();
    const sortedOwners = Array.from({ length: 3 }, () => PrivateKey.random()).sort((a, b) =>
      a.toPublicKey().toBase58().localeCompare(b.toPublicKey().toBase58())
    );
    const proposalHash = '987654321';

    const contract = await prisma.contract.create({
      data: {
        address: contractAddress,
        ownersCommitment: 'ordered',
        threshold: 2,
        numOwners: 3,
        configNonce: 0,
        networkId: '1',
      },
    });

    try {
      await prisma.owner.createMany({
        data: [
          { contractId: contract.id, address: sortedOwners[0].toPublicKey().toBase58(), index: 0, active: true },
          { contractId: contract.id, address: sortedOwners[1].toPublicKey().toBase58(), index: 2, active: true },
          { contractId: contract.id, address: sortedOwners[2].toPublicKey().toBase58(), index: 1, active: true },
        ],
      });

      await prisma.proposal.create({
        data: {
          contractId: contract.id,
          proposalHash,
          origin: 'offchain',
          status: 'pending',
          txType: TxType.TRANSFER.toString(),
        },
      });

      const res = await get(`/api/contracts/${contractAddress}/proposals/${proposalHash}/batch-payload`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.inputs.slice(0, 3).map((input: { signer: string }) => input.signer)).toEqual(
        sortedOwners.map((owner) => owner.toPublicKey().toBase58())
      );
    } finally {
      await prisma.proposal.deleteMany({ where: { contractId: contract.id } });
      await prisma.owner.deleteMany({ where: { contractId: contract.id } });
      await prisma.contract.delete({ where: { id: contract.id } });
    }
  });

  test('returns 404 for unknown proposal', async () => {
    const addr = guardAddress.toBase58();
    // The URL param middleware requires a numeric Field string; use a
    // valid-shaped hash that does not exist in the DB.
    const res = await get(`/api/contracts/${addr}/proposals/999999999999/batch-payload`);

    expect(res.status).toBe(404);
  });

  test('returns 404 for on-chain proposal', async () => {
    // Create an on-chain origin proposal directly in the DB
    const contract = await prisma.contract.findUnique({
      where: { address: guardAddress.toBase58() },
    });
    const onchainHash = '111111111';
    await prisma.proposal.create({
      data: {
        contractId: contract!.id,
        proposalHash: onchainHash,
        origin: 'onchain',
        status: 'pending',
      },
    });

    const addr = guardAddress.toBase58();
    const res = await get(`/api/contracts/${addr}/proposals/${onchainHash}/batch-payload`);
    expect(res.status).toBe(404);

    // cleanup
    await prisma.proposal.deleteMany({ where: { proposalHash: onchainHash } });
  });
});

// ---------------------------------------------------------------------------
// Cross-flow edge cases
// ---------------------------------------------------------------------------

describe('cross-flow edge cases', () => {
  test('rejects signature submission to on-chain proposal', async () => {
    const contract = await prisma.contract.findUnique({
      where: { address: guardAddress.toBase58() },
    });
    const onchainHash = '222222222';
    await prisma.proposal.create({
      data: {
        contractId: contract!.id,
        proposalHash: onchainHash,
        origin: 'onchain',
        status: 'pending',
      },
    });

    const addr = guardAddress.toBase58();
    const sig = Signature.create(owners[0].key, [Field(onchainHash)]);
    const sigJson = sig.toJSON();
    const res = await post(`/api/contracts/${addr}/proposals/${onchainHash}/signatures`, {
      signer: owners[0].pub.toBase58(),
      signatureR: sigJson.r,
      signatureS: sigJson.s,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Signatures can only be submitted to offchain proposals');

    // cleanup
    await prisma.proposal.deleteMany({ where: { proposalHash: onchainHash } });
  });

  test('offchain proposal creation blocked when on-chain proposal exists', async () => {
    const contract = await prisma.contract.findUnique({
      where: { address: guardAddress.toBase58() },
    });

    // Build a valid proposal so we can compute its hash
    const conflictProposal = new TransactionProposal({
      receivers: [
        new Receiver({ address: owners[0].pub, amount: UInt64.from(999) }),
        ...Array.from({ length: MAX_RECEIVERS - 1 }, () => Receiver.empty()),
      ],
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      memoHash: Field(0),
      uid: Field(77),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress,
    });
    const conflictHash = conflictProposal.hash().toString();

    // Simulate indexer creating an on-chain proposal
    await prisma.proposal.create({
      data: {
        contractId: contract!.id,
        proposalHash: conflictHash,
        origin: 'onchain',
        status: 'pending',
      },
    });

    // Try to create the same proposal offchain — should get 409
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: owners[0].pub.toBase58(), amount: '999' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '77',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: conflictHash,
      proposer: defaultProposer,
    });

    expect(res.status).toBe(409);

    // cleanup
    await prisma.proposal.deleteMany({ where: { proposalHash: conflictHash } });
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: API payload → on-chain executeTransferBatchSig
// ---------------------------------------------------------------------------

/** Reconstructs the o1js SignatureInputs struct from the batch-payload API response. */
function payloadToSignatureInputs(inputs: any[]): SignatureInputs {
  const dummySig = Signature.fromFields([Field(1), Field(1), Field(1)]);
  const dummyPk = PublicKey.fromFields([Field(1), Field(1)]);

  const built = inputs.map((slot: any) => {
    if (!slot.isSome) {
      return new SignatureInput({
        value: {
          signature: new SignatureOption({ value: dummySig, isSome: Bool(false) }),
          signer: dummyPk,
        },
        isSome: Bool(false),
      });
    }
    const pk = PublicKey.fromBase58(slot.signer);
    if (slot.hasSignature) {
      const sig = Signature.fromJSON({ r: slot.signatureR, s: slot.signatureS });
      return new SignatureInput({
        value: {
          signature: new SignatureOption({ value: sig, isSome: Bool(true) }),
          signer: pk,
        },
        isSome: Bool(true),
      });
    }
    return new SignatureInput({
      value: {
        signature: new SignatureOption({ value: dummySig, isSome: Bool(false) }),
        signer: pk,
      },
      isSome: Bool(true),
    });
  });

  return new SignatureInputs({ inputs: built });
}

describe('executeTransferBatchSig with API payload', () => {
  test('full round-trip: create proposal via API, collect sigs, execute on local chain', async () => {
    // 1. Set up local Mina blockchain with the same owners
    const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);

    const deployerKey = Local.testAccounts[0].key;
    const deployerAccount = Local.testAccounts[0];

    const zkAppKey = PrivateKey.random();
    const zkAppAddress = zkAppKey.toPublicKey();
    const zkApp = new MinaGuard(zkAppAddress);

    // Deploy
    const deployTxn = await Mina.transaction(deployerAccount, async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([deployerKey, zkAppKey]).send();

    // Fund contract
    const fundTxn = await Mina.transaction(deployerAccount, async () => {
      const update = AccountUpdate.createSigned(deployerAccount);
      update.send({ to: zkAppAddress, amount: UInt64.from(10_000_000_000) });
    });
    await fundTxn.prove();
    await fundTxn.sign([deployerKey]).send();

    // Setup with same owners and threshold
    const ownerPubs = owners.map((o) => o.pub);
    const ownersCommitment = computeOwnerChain(ownerPubs);
    const padded = [...ownerPubs];
    while (padded.length < MAX_OWNERS) padded.push(PublicKey.empty());

    const setupTxn = await Mina.transaction(deployerAccount, async () => {
      await zkApp.setup(
        ownersCommitment,
        Field(2),
        Field(owners.length),
        Field(1),
        new SetupOwnersInput({ owners: padded })
      );
    });
    await setupTxn.prove();
    await setupTxn.sign([deployerKey, zkAppKey]).send();

    // 2. Create a fresh proposal for this on-chain contract
    const recipient = Local.testAccounts[1];
    const chainProposal = new TransactionProposal({
      receivers: [
        new Receiver({ address: recipient, amount: UInt64.from(500_000_000) }),
        ...Array.from({ length: MAX_RECEIVERS - 1 }, () => Receiver.empty()),
      ],
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
      memoHash: Field(0),
      uid: Field(100),
      configNonce: Field(0),
      expiryBlock: Field(0),
      networkId: Field(1),
      guardAddress: zkAppAddress,
    });
    const chainProposalHash = chainProposal.hash().toString();

    // Seed DB with this contract and proposal via API
    await clearDatabase();
    await prisma.contract.create({
      data: {
        address: zkAppAddress.toBase58(),
        ownersCommitment: ownersCommitment.toString(),
        threshold: 2,
        numOwners: 3,
        configNonce: 0,
        networkId: '1',
      },
    });
    const dbContract = await prisma.contract.findUnique({ where: { address: zkAppAddress.toBase58() } });
    for (let i = 0; i < owners.length; i++) {
      await prisma.owner.create({
        data: {
          contractId: dbContract!.id,
          address: owners[i].pub.toBase58(),
          index: i,
          active: true,
        },
      });
    }

    // 3. Create offchain proposal via API
    const addr = zkAppAddress.toBase58();
    const createRes = await post(`/api/contracts/${addr}/proposals`, {
      receivers: [{ address: recipient.toBase58(), amount: '500000000' }],
      tokenId: '0',
      txType: '0',
      data: '0',
      memoHash: '0',
      uid: '100',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: chainProposalHash,
      proposer: defaultProposer,
    });
    expect(createRes.status).toBe(201);

    // 4. Submit signatures from owner 0 and owner 1 via API
    for (const idx of [0, 1]) {
      const sig = Signature.create(owners[idx].key, [Field(chainProposalHash)]);
      const sigJson = sig.toJSON();
      const sigRes = await post(`/api/contracts/${addr}/proposals/${chainProposalHash}/signatures`, {
        signer: owners[idx].pub.toBase58(),
        signatureR: sigJson.r,
        signatureS: sigJson.s,
      });
      expect(sigRes.status).toBe(201);
    }

    // 5. Fetch batch payload from API
    const payloadRes = await get(`/api/contracts/${addr}/proposals/${chainProposalHash}/batch-payload`);
    expect(payloadRes.status).toBe(200);
    const payload = await payloadRes.json() as any;
    expect(payload.ready).toBe(true);

    // 6. Reconstruct SignatureInputs from API payload and execute on-chain
    const sigs = payloadToSignatureInputs(payload.inputs);

    const approvalStore = new ApprovalStore();
    const approvalWitness = approvalStore.getWitness(chainProposal.hash());

    const balanceBefore = Mina.getBalance(recipient);

    const executeTxn = await Mina.transaction(deployerAccount, async () => {
      await zkApp.executeTransferBatchSig(chainProposal, approvalWitness, sigs);
    });
    await executeTxn.prove();
    await executeTxn.sign([deployerKey]).send();

    const balanceAfter = Mina.getBalance(recipient);
    expect(balanceAfter.sub(balanceBefore)).toEqual(UInt64.from(500_000_000));

    // Restore the shared seed for later describe blocks that still expect
    // the original guardAddress contract + owners (this test cleared the DB
    // at step 2 to seed a fresh zkApp-specific contract).
    await clearDatabase();
    await seedDatabase();
  });
});

describe('indexer transfer event batch dedup', () => {
  const dummyConfig: BackendConfig = {
    port: 0,
    databaseUrl: '',
    minaEndpoint: 'http://localhost:1',
    archiveEndpoint: 'http://localhost:1',
    lightnetAccountManager: undefined,
    minaFallbackEndpoint: null,
    archiveFallbackEndpoint: null,
    indexPollIntervalMs: 99999,
    indexStartHeight: 0,
    minaguardVkHash: null,
  };

  const recipient1 = PrivateKey.random().toPublicKey().toBase58();
  const recipient2 = PrivateKey.random().toPublicKey().toBase58();
  const emptyAddress = PublicKey.empty().toBase58();

  function makeTransferEvent(pHash: string, receiver: string, amount: string) {
    return { proposalHash: pHash, receiver, amount };
  }

  /** Creates a bound applyTransferEvent with its own local transferState. */
  function createApplyFn(indexer: MinaGuardIndexer) {
    const transferState = new Map<string, { count: number; skip: boolean; checked: boolean }>();
    const fn = (indexer as any).applyTransferEvent.bind(indexer);
    return (contractId: number, event: Record<string, unknown>) =>
      fn(contractId, event, transferState);
  }

  test('propose + execute in one sync with duplicate addresses and null txHash', async () => {
    const indexer = new MinaGuardIndexer(dummyConfig);
    const applyTransferEvent = createApplyFn(indexer);

    const contract = await prisma.contract.findUnique({
      where: { address: guardAddress.toBase58() },
    });

    // Create an on-chain proposal with no receivers
    const testHash = 'dedup-test-hash';
    const testProposal = await prisma.proposal.create({
      data: {
        contractId: contract!.id,
        proposalHash: testHash,
        origin: 'onchain',
        status: 'pending',
        txType: '0',
      },
    });

    // Simulate propose-time transfer events: 2 receivers (recipient1 appears twice
    // with different amounts) + (MAX_RECEIVERS - 2) empty slots = MAX_RECEIVERS total
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient1, '1000000000'));
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient1, '500000000'));
    for (let i = 0; i < MAX_RECEIVERS - 2; i++) {
      await applyTransferEvent(contract!.id, makeTransferEvent(testHash, emptyAddress, '0'));
    }

    // Verify both duplicate-address receivers were inserted
    let receivers = await prisma.proposalReceiver.findMany({
      where: { proposalId: testProposal.id },
      orderBy: { idx: 'asc' },
    });
    expect(receivers).toHaveLength(2);
    expect(receivers[0].address).toBe(recipient1);
    expect(receivers[0].amount).toBe('1000000000');
    expect(receivers[1].address).toBe(recipient1);
    expect(receivers[1].amount).toBe('500000000');

    // Simulate execute-time transfer events (second batch, same sync, null txHash)
    // These should ALL be skipped because count > MAX_RECEIVERS
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient1, '1000000000'));
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient1, '500000000'));
    for (let i = 0; i < MAX_RECEIVERS - 2; i++) {
      await applyTransferEvent(contract!.id, makeTransferEvent(testHash, emptyAddress, '0'));
    }

    // Verify no duplicates from execution batch
    receivers = await prisma.proposalReceiver.findMany({
      where: { proposalId: testProposal.id },
      orderBy: { idx: 'asc' },
    });
    expect(receivers).toHaveLength(2);

    // Cleanup
    await prisma.proposalReceiver.deleteMany({ where: { proposalId: testProposal.id } });
    await prisma.proposal.delete({ where: { id: testProposal.id } });
  });

  test('resumes a partially applied on-chain receiver batch from remaining events', async () => {
    const indexer = new MinaGuardIndexer(dummyConfig);

    const contract = await prisma.contract.findUnique({
      where: { address: guardAddress.toBase58() },
    });

    const testHash = 'partial-retry-hash';
    const testProposal = await prisma.proposal.create({
      data: {
        contractId: contract!.id,
        proposalHash: testHash,
        origin: 'onchain',
        status: 'pending',
        txType: '0',
      },
    });

    // Simulate a first sync that inserted 1 receiver before crashing
    await prisma.proposalReceiver.create({
      data: { proposalId: testProposal.id, idx: 0, address: recipient1, amount: '100' },
    });

    // Retry sync after the first transfer event was already persisted. Only
    // the remaining transfer events are replayed, so the missing receiver
    // rows must be appended instead of skipping the batch.
    const applyTransferEvent = createApplyFn(indexer);
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient2, '200'));
    for (let i = 0; i < MAX_RECEIVERS - 1; i++) {
      await applyTransferEvent(contract!.id, makeTransferEvent(testHash, emptyAddress, '0'));
    }

    // The original receiver is preserved and the missing receiver is backfilled.
    const receivers = await prisma.proposalReceiver.findMany({
      where: { proposalId: testProposal.id },
      orderBy: { idx: 'asc' },
    });
    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toMatchObject({ idx: 0, address: recipient1, amount: '100' });
    expect(receivers[1]).toMatchObject({ idx: 1, address: recipient2, amount: '200' });

    // Cleanup
    await prisma.proposalReceiver.deleteMany({ where: { proposalId: testProposal.id } });
    await prisma.proposal.delete({ where: { id: testProposal.id } });
  });

  test('skips transfer events for offchain proposals with pre-existing receivers', async () => {
    const indexer = new MinaGuardIndexer(dummyConfig);
    const applyTransferEvent = createApplyFn(indexer);

    const contract = await prisma.contract.findUnique({
      where: { address: guardAddress.toBase58() },
    });

    // Create offchain proposal with receivers already from the batch API
    const testHash = 'offchain-dedup-hash';
    const testProposal = await prisma.proposal.create({
      data: {
        contractId: contract!.id,
        proposalHash: testHash,
        origin: 'offchain',
        status: 'pending',
        txType: '0',
        receivers: {
          create: [
            { idx: 0, address: recipient1, amount: '1000000000' },
            { idx: 1, address: recipient2, amount: '2000000000' },
          ],
        },
      },
    });

    // Simulate execution transfer events arriving on-chain
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient1, '1000000000'));
    await applyTransferEvent(contract!.id, makeTransferEvent(testHash, recipient2, '2000000000'));
    for (let i = 0; i < MAX_RECEIVERS - 2; i++) {
      await applyTransferEvent(contract!.id, makeTransferEvent(testHash, emptyAddress, '0'));
    }

    // Verify still exactly 2 receivers (no duplicates from chain events)
    const receivers = await prisma.proposalReceiver.findMany({
      where: { proposalId: testProposal.id },
      orderBy: { idx: 'asc' },
    });
    expect(receivers).toHaveLength(2);
    expect(receivers[0].amount).toBe('1000000000');
    expect(receivers[1].amount).toBe('2000000000');

    // Cleanup
    await prisma.proposalReceiver.deleteMany({ where: { proposalId: testProposal.id } });
    await prisma.proposal.delete({ where: { id: testProposal.id } });
  });
});
