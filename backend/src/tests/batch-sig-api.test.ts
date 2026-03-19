import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Field, Mina, PrivateKey, PublicKey, Signature, UInt64, Bool, AccountUpdate } from 'o1js';
import express from 'express';
import type { Server } from 'http';
import { prisma } from '../db.js';
import { createBatchRouter } from '../batch-routes.js';
import {
  TransactionProposal, TxType, MinaGuard, SetupOwnersInput, MAX_OWNERS,
  computeOwnerChain, ApprovalStore, SignatureInputs, SignatureInput, SignatureOption,
} from 'contracts';

const PORT = 4444;
const BASE = `http://localhost:${PORT}`;

let server: Server;

// Test keys — 3 owners, threshold 2
const owners = Array.from({ length: 3 }, () => {
  const key = PrivateKey.random();
  return { key, pub: key.toPublicKey() };
});

const guardKey = PrivateKey.random();
const guardAddress = guardKey.toPublicKey();

const proposal = new TransactionProposal({
  to: owners[0].pub,
  amount: UInt64.from(1_000_000_000),
  tokenId: Field(0),
  txType: TxType.TRANSFER,
  data: Field(0),
  uid: Field(42),
  configNonce: Field(0),
  expiryBlock: Field(0),
  networkId: Field(1),
  guardAddress,
});

const proposalHash = proposal.hash().toString();

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
  server = app.listen(PORT);
});

afterAll(async () => {
  server?.close();
  await clearDatabase();
  await prisma.$disconnect();
});

describe('POST /api/contracts/:address/proposals', () => {
  test('creates an offchain proposal', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      toAddress: owners[0].pub.toBase58(),
      amount: '1000000000',
      tokenId: '0',
      txType: '0',
      data: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.proposalHash).toBe(proposalHash);
    expect(body.origin).toBe('offchain');
    expect(body.status).toBe('pending');
  });

  test('rejects duplicate proposal', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      toAddress: owners[0].pub.toBase58(),
      amount: '1000000000',
      tokenId: '0',
      txType: '0',
      data: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash,
    });

    expect(res.status).toBe(409);
  });

  test('rejects mismatched proposal hash', async () => {
    const addr = guardAddress.toBase58();
    const res = await post(`/api/contracts/${addr}/proposals`, {
      toAddress: owners[0].pub.toBase58(),
      amount: '1000000000',
      tokenId: '0',
      txType: '0',
      data: '0',
      uid: '42',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: '999999999',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Proposal hash mismatch');
  });
});

describe('POST /api/contracts/:address/proposals/:proposalHash/signatures', () => {
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
    expect(body.proposal.amount).toBe('1000000000');
  });

  test('returns 404 for unknown proposal', async () => {
    const addr = guardAddress.toBase58();
    const res = await get(`/api/contracts/${addr}/proposals/nonexistent/batch-payload`);

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
      to: owners[0].pub,
      amount: UInt64.from(999),
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
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
      toAddress: owners[0].pub.toBase58(),
      amount: '999',
      tokenId: '0',
      txType: '0',
      data: '0',
      uid: '77',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: conflictHash,
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
      to: recipient,
      amount: UInt64.from(500_000_000),
      tokenId: Field(0),
      txType: TxType.TRANSFER,
      data: Field(0),
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
      toAddress: recipient.toBase58(),
      amount: '500000000',
      tokenId: '0',
      txType: '0',
      data: '0',
      uid: '100',
      configNonce: '0',
      expiryBlock: '0',
      networkId: '1',
      guardAddress: addr,
      proposalHash: chainProposalHash,
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
  });
});
