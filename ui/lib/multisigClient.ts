// -- Multisig Contract Client (Comlink wrapper) ---------------------------
// Thin main-thread wrapper that delegates heavy o1js work to a Web Worker.
"use client";

import * as Comlink from 'comlink';
import type { WorkerApi } from './multisigClient.worker';
import type { NewProposalInput, Proposal, WalletType } from '@/lib/types';
import { getAuroSignFields, sendTransaction } from '@/lib/auroWallet';
import { signFields as ledgerSignFields, signFeePayer } from '@/lib/ledgerWallet';

/** Re-export types consumed by page components. */
export type { Proposal, NewProposalInput };

/** Configuration describing which wallet should sign fields. */
export interface SignerConfig {
  type: WalletType;
  ledgerAccountIndex?: number;
}

/** Optional callback to receive step-based progress updates from the worker. */
export type OnProgress = (step: string) => void;

/** Context for the Ledger signing modal: 'connecting' for address retrieval, 'signing' for tx signing. */
export type LedgerSigningContext = 'connecting' | 'signing';

/** Listener called when Ledger signing state changes. */
let ledgerSigningListener: ((signing: boolean, context?: LedgerSigningContext) => void) | null = null;

/** Registers a callback that fires when Ledger device interaction starts/stops. */
export function onLedgerSigningChange(fn: (signing: boolean, context?: LedgerSigningContext) => void): () => void {
  ledgerSigningListener = fn;
  return () => { ledgerSigningListener = null; };
}

/** Fires the Ledger signing listener (e.g. to show/hide the "Check Ledger" modal). */
export function setLedgerSigning(signing: boolean, context?: LedgerSigningContext) {
  ledgerSigningListener?.(signing, context);
}

let worker: Worker | null = null;
let api: Comlink.Remote<WorkerApi> | null = null;

/** Lazily creates the shared worker instance. */
function getWorkerApi(): Comlink.Remote<WorkerApi> {
  if (!api) {
    worker = new Worker(
      new URL('./multisigClient.worker.ts', import.meta.url)
    );
    api = Comlink.wrap<WorkerApi>(worker);
  }
  return api;
}

/** Proxied Auro sendTransaction callback for use inside the worker. Returns null for Ledger. */
function proxiedSendTx(signer?: SignerConfig) {
  if (signer?.type === 'ledger') return null;
  return Comlink.proxy((txJson: string) => sendTransaction(txJson));
}

/** Proxied Ledger fee payer signing callback. Returns undefined for Auro. */
function proxiedSignFeePayer(signer?: SignerConfig) {
  if (signer?.type !== 'ledger') return undefined;
  return Comlink.proxy(async (commitment: string) => {
    ledgerSigningListener?.(true, 'signing');
    try {
      return await signFeePayer(commitment, signer.ledgerAccountIndex);
    } finally {
      ledgerSigningListener?.(false);
    }
  });
}

/** Proxied signFields callback that dispatches to Auro or Ledger based on signer config. */
function proxiedSignFields(signer?: SignerConfig) {
  if (signer?.type === 'ledger') {
    return Comlink.proxy(async (fields: Array<string>) => {
      ledgerSigningListener?.(true, 'signing');
      try {
        return await ledgerSignFields(fields, signer.ledgerAccountIndex);
      } finally {
        ledgerSigningListener?.(false);
      }
    });
  }
  return Comlink.proxy(
    (fields: Array<string>) => getAuroSignFields(fields)
  );
}

/** Creates a proxied progress callback for use inside the worker. */
function proxiedProgress(onProgress?: OnProgress) {
  return Comlink.proxy((step: string) => onProgress?.(step));
}

/** Initializes the worker early so compilation starts before the first user action. */
export function warmupWorker() {
  getWorkerApi();
}

/** Sets the worker into e2e test mode with a private key for direct sign/send. */
export async function setTestKey(privateKeyBase58: string) {
  return getWorkerApi().setTestKey(privateKeyBase58);
}

/** Disables proof generation in the worker (for use with lightnet / test environments). */
export async function setSkipProofs(skip: boolean) {
  return getWorkerApi().setSkipProofs(skip);
}

// Expose test helper on window for e2e tests to call via page.evaluate()
if (typeof window !== 'undefined') {
  (window as any).__e2eSetTestKey = async (pk: string) => {
    return getWorkerApi().setTestKey(pk);
  };
  (window as any).__e2eSetSkipProofs = async (skip: boolean) => {
    return getWorkerApi().setSkipProofs(skip);
  };
}

/** Generates a random zkApp keypair in the worker (where o1js is loaded). */
export async function generateKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  return getWorkerApi().generateKeypair();
}

/**
 * Deploys MinaGuard contract account update and submits via Auro or Ledger.
 * The zkApp private key remains in browser memory for this call only.
 */
export async function deployContract(params: {
  feePayerAddress: string;
  zkAppPrivateKeyBase58: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  return getWorkerApi().deployContract(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}

/** Submits setup transaction with fixed-size owner list and threshold/network bootstrap. */
export async function setupContract(params: {
  zkAppAddress: string;
  feePayerAddress: string;
  owners: string[];
  threshold: number;
  networkId: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  return getWorkerApi().setupContract(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}

/** Deploys and initializes the contract in a single transaction. */
export async function deployAndSetupContract(params: {
  feePayerAddress: string;
  zkAppPrivateKeyBase58: string;
  owners: string[];
  threshold: number;
  networkId: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  return getWorkerApi().deployAndSetupContract(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}

/** Creates an offchain proposal in the backend and submits the proposer's first signature. */
export async function createOffchainProposal(params: {
  contractAddress: string;
  proposerAddress: string;
  input: NewProposalInput;
  configNonce: number;
  networkId: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  return getWorkerApi().createOffchainProposal(
    params,
    proxiedSignFields(signer),
    proxiedProgress(onProgress),
  );
}

/** Signs the proposal hash and submits the signature to the backend. */
export async function submitOffchainSignature(params: {
  contractAddress: string;
  signerAddress: string;
  proposalHash: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  return getWorkerApi().submitOffchainSignature(
    params,
    proxiedSignFields(signer),
    proxiedProgress(onProgress)
  );
}

/** Fetches batch payload, builds and sends an execute*BatchSig transaction. */
export async function executeBatchTx(params: {
  contractAddress: string;
  executorAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  return getWorkerApi().executeBatchTx(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}
