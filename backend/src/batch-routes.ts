import { Router } from 'express';
import { PublicKey } from 'o1js';
import { z } from 'zod';
import { prisma } from './db.js';
import { computeProposalHash, verifySignature, buildBatchPayload } from './batch-sig-service.js';

const base58PublicKey = z.string().refine((addr) => {
  try { PublicKey.fromBase58(addr); return true; } catch { return false; }
}, { message: 'Invalid Mina public key' });

const fieldString = z.string().regex(/^\d+$/, 'Must be a numeric string');
const hexHash = z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-char hex string');

const createProposalSchema = z.object({
  toAddress: base58PublicKey,
  amount: fieldString,
  tokenId: fieldString,
  txType: fieldString,
  data: fieldString,
  uid: fieldString,
  configNonce: fieldString,
  expiryBlock: fieldString,
  networkId: fieldString,
  guardAddress: base58PublicKey,
  proposalHash: hexHash,
});

const submitSignatureSchema = z.object({
  signer: base58PublicKey,
  signatureR: fieldString,
  signatureS: fieldString,
});

/** Creates the batch-sig API router for offchain signature aggregation. */
export function createBatchRouter(): Router {
  const router = Router();
  const safe = wrapAsyncRoute();

  // Validate :address param on all routes
  router.param('address', (_req, res, next, value) => {
    try {
      PublicKey.fromBase58(value);
      next();
    } catch {
      res.status(400).json({ error: 'Invalid contract address' });
      return;
    }
  });

  // Validate :proposalHash param on all routes
  router.param('proposalHash', (_req, res, next, value) => {
    if (hexHash.safeParse(value).success) {
      next();
    } else {
      res.status(400).json({ error: 'Invalid proposal hash' });
      return;
    }
  });

  /** Creates an offchain proposal for batch signature collection. */
  router.post('/api/contracts/:address/proposals', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (!contract.ownersCommitment) {
      res.status(400).json({ error: 'Contract not initialized' });
      return;
    }

    const parsed = createProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const {
      toAddress, amount, tokenId, txType, data,
      uid, configNonce, expiryBlock, networkId, guardAddress,
      proposalHash,
    } = parsed.data;

    if (guardAddress !== contract.address) {
      res.status(400).json({ error: 'guardAddress does not match contract address' });
      return;
    }

    if (Number(configNonce) !== (contract.configNonce ?? 0)) {
      res.status(400).json({ error: 'configNonce mismatch with on-chain state' });
      return;
    }

    if (networkId != null && contract.networkId != null && networkId !== contract.networkId) {
      res.status(400).json({ error: 'networkId mismatch with on-chain state' });
      return;
    }

    // Verify proposal hash matches the provided fields
    let computedHash: string;
    try {
      computedHash = computeProposalHash({
        toAddress, amount, tokenId, txType, data,
        uid, configNonce, expiryBlock, networkId, guardAddress,
      });
    } catch (err) {
      res.status(400).json({ error: 'Invalid proposal fields', detail: String(err) });
      return;
    }

    if (computedHash !== proposalHash) {
      res.status(400).json({
        error: 'Proposal hash mismatch',
        expected: computedHash,
        received: proposalHash,
      });
      return;
    }

    // Check for duplicate
    const existing = await prisma.proposal.findUnique({
      where: {
        contractId_proposalHash: {
          contractId: contract.id,
          proposalHash,
        },
      },
    });

    if (existing) {
      res.status(409).json({ error: 'Proposal already exists', proposal: existing });
      return;
    }

    const proposal = await prisma.proposal.create({
      data: {
        contractId: contract.id,
        proposalHash,
        toAddress,
        amount,
        tokenId,
        txType,
        data,
        uid,
        configNonce,
        expiryBlock,
        networkId,
        guardAddress,
        origin: 'offchain',
        status: 'pending',
      },
    });

    res.status(201).json(proposal);
  }));

  /** Submits a signature for an offchain proposal. */
  router.post('/api/contracts/:address/proposals/:proposalHash/signatures', safe(async (req, res) => {
    const contract = await prisma.contract.findUnique({
      where: { address: req.params.address },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const proposal = await prisma.proposal.findUnique({
      where: {
        contractId_proposalHash: {
          contractId: contract.id,
          proposalHash: req.params.proposalHash,
        },
      },
    });

    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }

    if (proposal.origin !== 'offchain') {
      res.status(400).json({ error: 'Signatures can only be submitted to offchain proposals' });
      return;
    }

    if (proposal.status !== 'pending') {
      res.status(400).json({ error: `Proposal is ${proposal.status}, not pending` });
      return;
    }

    const parsed = submitSignatureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { signer, signatureR, signatureS } = parsed.data;

    // Verify signer is an active owner
    const owner = await prisma.owner.findUnique({
      where: {
        contractId_address: {
          contractId: contract.id,
          address: signer,
        },
      },
    });

    if (!owner || !owner.active) {
      res.status(403).json({ error: 'Signer is not an active owner of this contract' });
      return;
    }

    // Check duplicate
    const existingApproval = await prisma.approval.findUnique({
      where: {
        proposalId_approver: {
          proposalId: proposal.id,
          approver: signer,
        },
      },
    });

    if (existingApproval) {
      res.status(409).json({ error: 'Signature already submitted for this signer' });
      return;
    }

    // Verify signature
    let valid: boolean;
    try {
      valid = verifySignature(
        signer,
        signatureR,
        signatureS,
        proposal.proposalHash
      );
    } catch (err) {
      res.status(400).json({ error: 'Invalid signature format', detail: String(err) });
      return;
    }

    if (!valid) {
      res.status(400).json({ error: 'Signature verification failed' });
      return;
    }

    const approvalCount = await prisma.$transaction(async (tx) => {
      await tx.approval.create({
        data: {
          proposalId: proposal.id,
          approver: signer,
          signatureR: signatureR,
          signatureS: signatureS,
        },
      });

      const count = await tx.approval.count({
        where: { proposalId: proposal.id },
      });

      await tx.proposal.update({
        where: { id: proposal.id },
        data: { approvalCount: count },
      });

      return count;
    });

    const threshold = contract.threshold ?? 1;

    res.status(201).json({
      approvalCount,
      threshold,
      ready: approvalCount >= threshold,
    });
  }));

  /** Returns the aggregated batch payload for client-side execution. */
  router.get('/api/contracts/:address/proposals/:proposalHash/batch-payload', safe(async (req, res) => {
    const result = await buildBatchPayload(req.params.address, req.params.proposalHash);

    if (!result) {
      res.status(404).json({ error: 'Contract or proposal not found' });
      return;
    }

    res.json(result);
  }));

  return router;
}

/** Wraps async route handlers so thrown errors are forwarded to Express error middleware. */
function wrapAsyncRoute() {
  return (handler: (req: any, res: any) => Promise<void>) => {
    return (req: any, res: any, next: any) => {
      void handler(req, res).catch(next);
    };
  };
}
