import {
  OFFLINE_MAX_FEE_NANOMINA,
  OFFLINE_MIN_FEE_NANOMINA,
  OFFLINE_RESPONSE_VERSION,
} from 'contracts/offline-format';

/** Owner requests are version 3 (`OFFLINE_BUNDLE_VERSION`); signed responses stay at version 1. */
export { OFFLINE_RESPONSE_VERSION };

export function assertOfflineResponseVersion(version: unknown): void {
  if (version !== OFFLINE_RESPONSE_VERSION) {
    throw new Error(`Unsupported signed response version (${version}). Expected ${OFFLINE_RESPONSE_VERSION}; export and sign a new request with matching UI and CLI releases.`);
  }
}

/** Read the fee from the actual signed command, not a response metadata field. */
export function signedOwnerFeeNanomina(transaction: unknown, expectedFee?: number): number {
  const fee = (transaction as { feePayer?: { body?: { fee?: unknown } } } | null)?.feePayer?.body?.fee;
  if (typeof fee !== 'string' || !/^(0|[1-9]\d*)$/.test(fee)) {
    throw new Error('Signed transaction has no valid fee. Not broadcasting.');
  }
  const nanomina = Number(fee);
  if (!Number.isSafeInteger(nanomina) || nanomina < OFFLINE_MIN_FEE_NANOMINA || nanomina > OFFLINE_MAX_FEE_NANOMINA) {
    throw new Error('Signed transaction fee is outside the allowed 0.01–0.1 MINA range. Not broadcasting.');
  }
  if (expectedFee !== undefined && nanomina !== expectedFee) {
    throw new Error('Signed transaction fee differs from the exported request. Not broadcasting.');
  }
  return nanomina;
}
