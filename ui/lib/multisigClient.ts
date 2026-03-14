// -- Multisig Contract Client (Comlink wrapper) ---------------------------
// Thin main-thread wrapper that delegates heavy o1js work to a Web Worker.
"use client";

import * as Comlink from 'comlink';
import type { WorkerApi } from './multisigClient.worker';
import type { NewProposalInput, Proposal } from '@/lib/types';
import { getAuroSignFields, sendTransaction } from '@/lib/auroWallet';

/** Re-export types consumed by page components. */
export type { Proposal, NewProposalInput };

/** Optional callback to receive step-based progress updates from the worker. */
export type OnProgress = (step: string) => void;

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

/** Proxied Auro sendTransaction callback for use inside the worker. */
function proxiedSendTx() {
  return Comlink.proxy((txJson: string) => sendTransaction(txJson));
}

/** Proxied Auro signFields callback for use inside the worker. */
function proxiedSignFields() {
  return Comlink.proxy(
    (fields: Array<string | number>) => getAuroSignFields(fields)
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

/** Generates a random zkApp keypair in the worker (where o1js is loaded). */
export async function generateKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  return getWorkerApi().generateKeypair();
}

/**
 * Deploys MinaGuard contract account update and submits it through Auro.
 * The zkApp private key remains in browser memory for this call only.
 */
export async function deployContract(params: {
  feePayerAddress: string;
  zkAppPrivateKeyBase58: string;
}, onProgress?: OnProgress): Promise<string | null> {
  return getWorkerApi().deployContract(params, proxiedSendTx(), proxiedProgress(onProgress));
}

/** Submits setup transaction with fixed-size owner list and threshold/network bootstrap. */
export async function setupContract(params: {
  zkAppAddress: string;
  feePayerAddress: string;
  owners: string[];
  threshold: number;
  networkId: string;
}, onProgress?: OnProgress): Promise<string | null> {
  return getWorkerApi().setupContract(params, proxiedSendTx(), proxiedProgress(onProgress));
}

/** Creates, proves, and sends a MinaGuard propose transaction using Auro field signature. */
export async function createProposeTx(params: {
  contractAddress: string;
  proposerAddress: string;
  input: NewProposalInput;
}, onProgress?: OnProgress): Promise<string | null> {
  return getWorkerApi().createProposeTx(
    params,
    proxiedSignFields(),
    proxiedSendTx(),
    proxiedProgress(onProgress)
  );
}

/** Creates, proves, and submits approveProposal transaction for selected proposal hash. */
export async function createApproveTx(params: {
  contractAddress: string;
  approverAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress): Promise<string | null> {
  return getWorkerApi().createApproveTx(
    params,
    proxiedSignFields(),
    proxiedSendTx(),
    proxiedProgress(onProgress)
  );
}

/** Creates, proves, and submits execution transaction for the selected proposal type. */
export async function createExecuteTx(params: {
  contractAddress: string;
  executorAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress): Promise<string | null> {
  return getWorkerApi().createExecuteTx(params, proxiedSendTx(), proxiedProgress(onProgress));
}
