import { Router } from 'express';
import { prisma } from './db.js';
import { computeProposalHash, verifySignature, buildBatchPayload } from './batch-sig-service.js';

/** Creates the batch-sig API router for offchain signature aggregation. */
export function createBatchRouter(): Router {
  const router = Router();
  const safe = wrapAsyncRoute();

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

    const {
      toAddress, amount, tokenId, txType, data,
      uid, configNonce, expiryBlock, networkId, guardAddress,
      proposalHash,
    } = req.body;

    if (!proposalHash || !toAddress || !guardAddress) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    if (guardAddress !== contract.address) {
      res.status(400).json({ error: 'guardAddress does not match contract address' });
      return;
    }

    if (configNonce !== undefined && String(configNonce) !== String(contract.configNonce ?? 0)) {
      res.status(400).json({ error: 'configNonce mismatch with on-chain state' });
      return;
    }

    if (networkId !== undefined && contract.networkId !== null && String(networkId) !== contract.networkId) {
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

    if (computedHash !== String(proposalHash)) {
      res.status(400).json({
        error: 'Proposal hash mismatch',
        expected: computedHash,
        received: String(proposalHash),
      });
      return;
    }

    // Check for duplicate
    const existing = await prisma.proposal.findUnique({
      where: {
        contractId_proposalHash: {
          contractId: contract.id,
          proposalHash: String(proposalHash),
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
        proposalHash: String(proposalHash),
        toAddress: String(toAddress),
        amount: String(amount),
        tokenId: String(tokenId),
        txType: String(txType),
        data: String(data),
        uid: String(uid),
        configNonce: String(configNonce),
        expiryBlock: String(expiryBlock),
        networkId: String(networkId),
        guardAddress: String(guardAddress),
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

    const { signer, signatureR, signatureS } = req.body;

    if (!signer || !signatureR || !signatureS) {
      res.status(400).json({ error: 'Missing required fields: signer, signatureR, signatureS' });
      return;
    }

    // Verify signer is an active owner
    const owner = await prisma.owner.findUnique({
      where: {
        contractId_address: {
          contractId: contract.id,
          address: String(signer),
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
          approver: String(signer),
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
        String(signer),
        String(signatureR),
        String(signatureS),
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

    await prisma.approval.create({
      data: {
        proposalId: proposal.id,
        approver: String(signer),
        signatureR: String(signatureR),
        signatureS: String(signatureS),
      },
    });

    const approvalCount = await prisma.approval.count({
      where: { proposalId: proposal.id },
    });

    await prisma.proposal.update({
      where: { id: proposal.id },
      data: { approvalCount },
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
