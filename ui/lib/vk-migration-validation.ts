import type { OfflineMigrationBundle, OfflineMigrationResponse } from './offline-signing';

/** Validate the signed command, since the response wrapper is editable JSON. */
export function assertMigrationResponse(response: OfflineMigrationResponse, request: OfflineMigrationBundle): string {
  if (response.version !== 2 || response.type !== 'offline-signed-tx' || response.action !== 'migrate-verification-key' ||
      response.contractAddress !== request.contractAddress || response.feePayerAddress !== request.feePayerAddress ||
      response.sourceVerificationKeyHash !== request.sourceVerificationKeyHash ||
      response.targetVerificationKeyHash !== request.targetVerificationKeyHash) {
    throw new Error('Signed response does not match this migration request.');
  }
  const command = typeof response.transaction === 'string' ? JSON.parse(response.transaction) : response.transaction;
  const updates = command?.accountUpdates;
  const update = updates?.[0];
  const body = update?.body;
  const replacement = body?.update?.verificationKey;
  if (!Array.isArray(updates) || updates.length !== 1 ||
      command?.feePayer?.body?.publicKey !== request.feePayerAddress ||
      command?.feePayer?.body?.fee !== '100000000' ||
      !command?.feePayer?.authorization ||
      body?.publicKey !== request.contractAddress ||
      body?.tokenId !== request.accounts[request.contractAddress]?.token ||
      body?.authorizationKind?.isSigned !== true || body?.authorizationKind?.isProved !== false ||
      !update?.authorization?.signature ||
      replacement?.hash !== request.targetVerificationKeyHash || !replacement?.data ||
      body?.balanceChange?.magnitude !== '0' ||
      Object.entries(body?.update ?? {}).some(([name, value]) =>
        name !== 'verificationKey' && value != null &&
        !(Array.isArray(value) && value.every((item) => item == null))) ||
      (body?.events?.length ?? 0) !== 0 || (body?.actions?.length ?? 0) !== 0) {
    throw new Error('Signed command contains an unexpected account update.');
  }
  return JSON.stringify(command);
}
