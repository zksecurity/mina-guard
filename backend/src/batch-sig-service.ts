import { Field, PublicKey, Signature, UInt64 } from 'o1js';
import { MAX_OWNERS, MAX_RECEIVERS, Receiver, TransactionProposal, TxType } from 'contracts';
import { prisma } from './db.js';

const EMPTY_PUBLIC_KEY_BASE58 = PublicKey.empty().toBase58();

export interface BatchPayloadProposal {
  proposalHash: string;
  toAddress: string | null;
  tokenId: string | null;
  txType: string | null;
  data: string | null;
  uid: string | null;
  configNonce: string | null;
  expiryBlock: string | null;
  networkId: string | null;
  guardAddress: string | null;
  receivers: Array<{ index: number; address: string; amount: string }>;
  recipientCount: number;
  totalAmount: string | null;
}

function safePublicKey(base58: string): InstanceType<typeof PublicKey> {
  if (!base58) throw new Error('Missing public key');
  if (base58 === EMPTY_PUBLIC_KEY_BASE58) return PublicKey.empty();
  return PublicKey.fromBase58(base58);
}

/** Recomputes the Poseidon proposal hash from individual fields. */
export function computeProposalHash(params: {
  receivers: Array<{ address: string; amount: string }>;
  tokenId: string;
  txType: string;
  data: string;
  memoHash: string;
  uid: string;
  configNonce: string;
  expiryBlock: string;
  networkId: string;
  guardAddress: string;
}): string {
  const paddedReceivers = params.receivers.map((receiver) => new Receiver({
    address: safePublicKey(receiver.address),
    amount: UInt64.from(receiver.amount),
  }));
  while (paddedReceivers.length < MAX_RECEIVERS) {
    paddedReceivers.push(Receiver.empty());
  }

  const proposal = new TransactionProposal({
    receivers: paddedReceivers,
    tokenId: Field(params.tokenId),
    txType: Field(params.txType),
    data: Field(params.data),
    memoHash: Field(params.memoHash),
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
  proposal: BatchPayloadProposal;
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
    include: {
      receivers: {
        orderBy: { idx: 'asc' },
      },
    },
  });
  if (!proposal) return null;
  if (proposal.origin !== 'offchain') return null;

  const owners = await prisma.owner.findMany({
    where: { contractId: contract.id, active: true },
    // Batch verification rebuilds the owner commitment by hashing owners in
    // ascending base58 order, so the payload must preserve that exact order.
    orderBy: { address: 'asc' },
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
  const receivers = proposal.receivers.map((receiver) => ({
    index: receiver.idx,
    address: receiver.address,
    amount: receiver.amount,
  }));

  return {
    ready: approvals.length >= threshold,
    threshold,
    approvalCount: approvals.length,
    proposal: {
      proposalHash: proposal.proposalHash,
      toAddress: proposal.toAddress,
      tokenId: proposal.tokenId,
      txType: proposal.txType,
      data: proposal.data,
      uid: proposal.uid,
      configNonce: proposal.configNonce,
      expiryBlock: proposal.expiryBlock,
      networkId: proposal.networkId,
      guardAddress: proposal.guardAddress,
      receivers,
      recipientCount: proposal.txType === TxType.TRANSFER.toString() ? receivers.length : 0,
      totalAmount: proposal.txType === TxType.TRANSFER.toString()
        ? receivers.reduce((sum, receiver) => sum + BigInt(receiver.amount), 0n).toString()
        : null,
    },
    inputs,
  };
}
