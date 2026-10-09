import { describe, expect, it } from 'bun:test';
import { assertMigrationResponse } from '../lib/vk-migration-validation';
import type { OfflineMigrationBundle, OfflineMigrationResponse } from '../lib/offline-signing';
import { AccountUpdate, Field, Mina, PrivateKey, TokenId } from 'o1js';

function fixture(): { request: OfflineMigrationBundle; response: OfflineMigrationResponse } {
  const request = {
    version: 2, action: 'migrate-verification-key', minaNetwork: 'testnet',
    contractAddress: 'vault', feePayerAddress: 'payer',
    sourceVerificationKeyHash: '111', sourceTxnVersion: '3',
    targetVerificationKeyHash: '222', targetTxnVersion: '4',
    accounts: { vault: { token: 'default-token' } },
  } as unknown as OfflineMigrationBundle;
  const response: OfflineMigrationResponse = {
    version: 2, type: 'offline-signed-tx', action: 'migrate-verification-key',
    contractAddress: 'vault', feePayerAddress: 'payer',
    sourceVerificationKeyHash: '111', targetVerificationKeyHash: '222',
    transaction: {
      feePayer: { body: { publicKey: 'payer', fee: '100000000' }, authorization: 'fee-signature' },
      accountUpdates: [{
        body: {
          publicKey: 'vault', tokenId: 'default-token',
          authorizationKind: { isSigned: true, isProved: false },
          balanceChange: { magnitude: '0', sgn: 'Positive' },
          update: { appState: Array(32).fill(null), verificationKey: { data: 'reviewed-key', hash: '222' }, permissions: null },
          events: [], actions: [],
        },
        authorization: { signature: 'vault-signature', proof: null },
      }],
    },
  };
  return { request, response };
}

describe('offline VK migration import', () => {
  it('accepts an actual o1js signed verification-key update', async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(local);
    const payer = local.testAccounts[0];
    const vaultKey = PrivateKey.random();
    const tx = await Mina.transaction({ sender: payer, fee: 100_000_000 }, async () => {
      AccountUpdate.createSigned(vaultKey.toPublicKey()).account.verificationKey.set({ data: 'reviewed-key', hash: Field(222) });
    });
    tx.sign([payer.key, vaultKey]);
    const { request, response } = fixture();
    request.contractAddress = response.contractAddress = vaultKey.toPublicKey().toBase58();
    request.feePayerAddress = response.feePayerAddress = payer.toBase58();
    request.accounts[request.contractAddress] = { token: TokenId.toBase58(TokenId.default) } as any;
    response.transaction = JSON.parse(tx.toJSON());
    expect(() => assertMigrationResponse(response, request)).not.toThrow();
  });

  it('accepts the narrow signed VK replacement command', () => {
    const { request, response } = fixture();
    expect(JSON.parse(assertMigrationResponse(response, request)).accountUpdates).toHaveLength(1);
  });

  it('rejects a swapped vault, extra payment, and permission change', () => {
    const swapped = fixture();
    swapped.response.contractAddress = 'other-vault';
    expect(() => assertMigrationResponse(swapped.response, swapped.request)).toThrow('does not match');
    const payment = fixture();
    (payment.response.transaction as any).accountUpdates[0].body.balanceChange.magnitude = '1';
    expect(() => assertMigrationResponse(payment.response, payment.request)).toThrow('unexpected account update');
    const permissions = fixture();
    (permissions.response.transaction as any).accountUpdates[0].body.update.permissions = { send: 'Signature' };
    expect(() => assertMigrationResponse(permissions.response, permissions.request)).toThrow('unexpected account update');
  });
});
