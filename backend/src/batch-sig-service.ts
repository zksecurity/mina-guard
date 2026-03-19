import { Field, PublicKey, Signature, UInt64 } from 'o1js';
import { TransactionProposal, MAX_OWNERS } from 'contracts';
import { prisma } from './db.js';

function safePublicKey(base58: string | null | undefined): InstanceType<typeof PublicKey> {
  if (!base58) return PublicKey.empty();
  try {
    return PublicKey.fromBase58(base58);
  } catch {
    return PublicKey.empty();
  }
}

/** Recomputes the Poseidon proposal hash from individual fields. */
export function computeProposalHash(params: {
  toAddress: string;
  amount: string;
  tokenId: string;
  txType: string;
  data: string;
  uid: string;
  configNonce: string;
  expiryBlock: string;
  networkId: string;
  guardAddress: string;
}): string {
  const proposal = new TransactionProposal({
    to: safePublicKey(params.toAddress),
    amount: UInt64.from(params.amount),
    tokenId: Field(params.tokenId),
    txType: Field(params.txType),
    data: Field(params.data),
    uid: Field(params.uid),
    configNonce: Field(params.configNonce),
    expiryBlock: Field(params.expiryBlock),
    networkId: Field(params.networkId),
    guardAddress: PublicKey.fromBase58(params.guardAddress),
  });
  return proposal.hash().toString();
}

/** Verifies a Mina signature against a proposal hash in non-circuit mode. */
export function verifySignature(
  signerBase58: string,
  signatureR: string,
  signatureS: string,
  proposalHash: string
): boolean {
  const pk = PublicKey.fromBase58(signerBase58);
  const sig = Signature.fromJSON({ r: signatureR, s: signatureS });
  const message = Field(proposalHash);
  return sig.verify(pk, [message]).toBoolean();
}

/**
 * Builds the batch payload that a client needs to call execute*BatchSig().
 * Returns the ordered SignatureInputs array (MAX_OWNERS slots) plus metadata.
 */
export async function buildBatchPayload(
  contractAddress: string,
  proposalHash: string
): Promise<{
  ready: boolean;
  threshold: number;
  approvalCount: number;
  proposal: Record<string, string | null>;
  inputs: Array<{
    isSome: boolean;
    signer: string | null;
    hasSignature: boolean;
    signatureR: string | null;
    signatureS: string | null;
  }>;
} | null> {
  const contract = await prisma.contract.findUnique({
    where: { address: contractAddress },
  });
  if (!contract) return null;

  const proposal = await prisma.proposal.findUnique({
    where: {
      contractId_proposalHash: {
        contractId: contract.id,
        proposalHash,
      },
    },
  });
  if (!proposal) return null;
  if (proposal.origin !== 'offchain') return null;

  const owners = await prisma.owner.findMany({
    where: { contractId: contract.id, active: true },
    orderBy: [{ index: 'asc' }, { createdAt: 'asc' }],
  });

  const approvals = await prisma.approval.findMany({
    where: {
      proposalId: proposal.id,
      signatureR: { not: null },
      signatureS: { not: null },
    },
  });

  const sigByAddress = new Map(
    approvals.map((a) => [a.approver, { r: a.signatureR!, s: a.signatureS! }])
  );

  const inputs: Array<{
    isSome: boolean;
    signer: string | null;
    hasSignature: boolean;
    signatureR: string | null;
    signatureS: string | null;
  }> = [];

  for (let i = 0; i < MAX_OWNERS; i++) {
    const owner = owners[i];
    if (owner) {
      const sig = sigByAddress.get(owner.address);
      inputs.push({
        isSome: true,
        signer: owner.address,
        hasSignature: !!sig,
        signatureR: sig?.r ?? null,
        signatureS: sig?.s ?? null,
      });
    } else {
      inputs.push({
        isSome: false,
        signer: null,
        hasSignature: false,
        signatureR: null,
        signatureS: null,
      });
    }
  }

  const threshold = contract.threshold ?? 1;

  return {
    ready: approvals.length >= threshold,
    threshold,
    approvalCount: approvals.length,
    proposal: {
      proposalHash: proposal.proposalHash,
      toAddress: proposal.toAddress,
      amount: proposal.amount,
      tokenId: proposal.tokenId,
      txType: proposal.txType,
      data: proposal.data,
      uid: proposal.uid,
      configNonce: proposal.configNonce,
      expiryBlock: proposal.expiryBlock,
      networkId: proposal.networkId,
      guardAddress: proposal.guardAddress,
    },
    inputs,
  };
}
