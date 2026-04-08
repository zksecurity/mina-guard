import { Router } from 'express';
import { PublicKey } from 'o1js';
import { z } from 'zod';
import { MAX_RECEIVERS, TxType } from 'contracts';
import { prisma } from './db.js';
import { computeProposalHash, verifySignature, buildBatchPayload } from './batch-sig-service.js';
import { serializeProposalRecord } from './proposal-record.js';
import {
  minaPublicKeySchema,
  proposalHashParamSchema,
  addressParamsSchema,
  proposalParamsSchema,
  addressParamsMiddleware,
  proposalParamsMiddleware,
  type AddressParams,
  type ProposalParams,
} from './request-validation.js';
import { wrapAsyncRoute } from './route-utils.js';

const base58PublicKey = minaPublicKeySchema;
const EMPTY_PUBLIC_KEY_BASE58 = PublicKey.empty().toBase58();
const proposalTargetPublicKey = z.string().refine((value) => {
  if (value === EMPTY_PUBLIC_KEY_BASE58) return true;
  return base58PublicKey.safeParse(value).success;
}, { message: 'Invalid Mina public key' });

const fieldString = z.string().regex(/^\d+$/, 'Must be a numeric string');
const hexHash = proposalHashParamSchema;
const receiverSchema = z.object({
  address: proposalTargetPublicKey,
  amount: fieldString,
});

const createProposalSchema = z.object({
  toAddress: proposalTargetPublicKey.optional(),
  receivers: z.array(receiverSchema).max(MAX_RECEIVERS).optional(),
  tokenId: fieldString,
  txType: fieldString,
  data: fieldString,
  uid: fieldString,
  configNonce: fieldString,
  expiryBlock: fieldString,
  networkId: fieldString,
  guardAddress: base58PublicKey,
  proposalHash: hexHash,
  proposer: base58PublicKey,
});

const submitSignatureSchema = z.object({
  signer: base58PublicKey,
  signatureR: fieldString,
  signatureS: fieldString,
});

function getProposalTargetRequirement(params: { txType: string; data: string }): 'required' | 'optional' {
  if (params.txType === TxType.ADD_OWNER.toString()) return 'required';
  if (params.txType === TxType.REMOVE_OWNER.toString()) return 'required';
  if (params.txType === TxType.SET_DELEGATE.toString()) {
    return params.data === '0' ? 'optional' : 'required';
  }
  return 'optional';
}

/** Creates the batch-sig API router for offchain signature aggregation. */
export function createBatchRouter(): Router {
  const router = Router();
  const safe = wrapAsyncRoute();

  /** Creates an offchain proposal for batch signature collection. */
  router.post('/api/contracts/:address/proposals', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({
      where: { address },
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
      toAddress, receivers, tokenId, txType, data,
      uid, configNonce, expiryBlock, networkId, guardAddress,
      proposalHash, proposer,
    } = parsed.data;

    const normalizedReceivers = normalizeProposalReceivers({
      txType,
      receivers,
    });
    if (!normalizedReceivers.ok) {
      res.status(400).json({ error: normalizedReceivers.error });
      return;
    }

    const targetRequirement = getProposalTargetRequirement({ txType, data });
    if (targetRequirement === 'required' && !toAddress) {
      res.status(400).json({ error: 'Proposal toAddress is required for this transaction type' });
      return;
    }

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

    if (normalizedReceivers.receivers.length > MAX_RECEIVERS) {
      res.status(400).json({ error: `Too many receivers; maximum is ${MAX_RECEIVERS}` });
      return;
    }

    // Verify proposal hash matches the provided fields
    let computedHash: string;
    try {
      computedHash = computeProposalHash({
        receivers: normalizedReceivers.receivers,
        tokenId, txType, data,
        uid, configNonce, expiryBlock, networkId, guardAddress,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'Invalid proposal fields', detail: message });
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
        tokenId,
        txType,
        data,
        uid,
        configNonce,
        expiryBlock,
        networkId,
        guardAddress,
        proposer,
        origin: 'offchain',
        status: 'pending',
        receivers: normalizedReceivers.receivers.length > 0 ? {
          create: normalizedReceivers.receivers.map((receiver, index) => ({
            idx: index,
            address: receiver.address,
            amount: receiver.amount,
          })),
        } : undefined,
      },
      include: {
        receivers: {
          orderBy: { idx: 'asc' },
        },
      },
    });

    res.status(201).json({
      ...serializeProposalRecord(proposal),
      warnings: normalizedReceivers.warnings,
    });
  }));

  /** Submits a signature for an offchain proposal. */
  router.post(
    '/api/contracts/:address/proposals/:proposalHash/signatures',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;

      const contract = await prisma.contract.findUnique({
        where: { address },
      });

      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: {
          contractId_proposalHash: {
            contractId: contract.id,
            proposalHash,
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
    })
  );

  /** Returns the aggregated batch payload for client-side execution. */
  router.get(
    '/api/contracts/:address/proposals/:proposalHash/batch-payload',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;
      const result = await buildBatchPayload(address, proposalHash);

      if (!result) {
        res.status(404).json({ error: 'Contract or proposal not found' });
        return;
      }

      res.json(result);
    })
  );

  router.use((error: unknown, req: any, res: any, _next: any) => {
    console.error(
      `[batch-api] ${req.method} ${req.originalUrl}`,
      error instanceof Error ? error.stack ?? error.message : error
    );
    const message =
      error instanceof Error ? error.message : 'Unknown backend error';
    res.status(500).json({ error: message });
  });

  return router;
}

function normalizeProposalReceivers(params: {
  txType: string;
  receivers?: Array<{ address: string; amount: string }>;
}):
  | { ok: true; receivers: Array<{ address: string; amount: string }>; warnings: string[] }
  | { ok: false; error: string } {
  const isTransfer = params.txType === TxType.TRANSFER.toString();
  if (!isTransfer) {
    return { ok: true, receivers: [], warnings: [] };
  }

  const receivers = params.receivers ?? [];
  if (receivers.length === 0) {
    return { ok: false, error: 'Transfer proposals must include at least one receiver' };
  }

  const seen = new Set<string>();
  let hasDuplicateReceiver = false;
  for (const receiver of receivers) {
    if (seen.has(receiver.address)) {
      hasDuplicateReceiver = true;
      continue;
    }
    seen.add(receiver.address);
  }

  return {
    ok: true,
    receivers,
    warnings: hasDuplicateReceiver
      ? ['Transfer proposal contains duplicate receiver addresses; duplicates were allowed.']
      : [],
  };
}
