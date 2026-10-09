import { describe, expect, it } from 'bun:test';
import { GUARD_PERMISSION_KINDS, GUARD_SET_VERIFICATION_KEY_TXN_VERSION } from 'contracts';
import { validateMigrationBundle, renderMigrationSummary, type MigrationBundle } from '../migrate-vk.ts';

const olderVersion = String(Number(GUARD_SET_VERIFICATION_KEY_TXN_VERSION) - 1);
function request(): MigrationBundle {
  return {
    version: 2,
    action: 'migrate-verification-key',
    minaNetwork: 'testnet',
    contractAddress: 'vault',
    feePayerAddress: 'payer',
    sourceVerificationKeyHash: '123',
    sourceTxnVersion: olderVersion,
    targetVerificationKeyHash: '456',
    targetTxnVersion: GUARD_SET_VERIFICATION_KEY_TXN_VERSION,
    accounts: {
      vault: {
        nonce: '0', balance: { total: '0' }, token: '',
        zkappState: Array(32).fill('0'),
        verificationKey: { verificationKey: 'source-key', hash: '123' },
        permissions: { ...GUARD_PERMISSION_KINDS, setVerificationKey: { auth: 'Impossible', txnVersion: olderVersion } },
      },
      payer: { nonce: '0', balance: { total: '1000000000' }, token: '', zkappState: null, verificationKey: null, permissions: null },
    },
  };
}

describe('deploy-key VK migration request', () => {
  it('shows both VK hashes and the deploy-key authority before signing', () => {
    const summary = renderMigrationSummary(request());
    expect(summary).toContain('Installed VK hash: 123');
    expect(summary).toContain('Replacement VK hash: 456');
    expect(summary).toContain('bypasses owner voting');
  });

  it('makes terminal controls in an untrusted request visible', () => {
    const malicious = request();
    malicious.feePayerAddress = 'payer\u001b[2J';
    malicious.accounts[malicious.feePayerAddress] = malicious.accounts.payer;
    const summary = renderMigrationSummary(malicious);
    expect(summary).not.toContain('\u001b[2J');
    expect(summary).toContain('\\u{1B}');
  });

  it('rejects a current-version vault and changed permission vector', () => {
    const current = request();
    current.sourceTxnVersion = current.targetTxnVersion;
    (current.accounts.vault.permissions!.setVerificationKey as { txnVersion: string }).txnVersion = current.targetTxnVersion;
    expect(() => validateMigrationBundle(current)).toThrow('older transaction version');
    const changed = request();
    changed.accounts.vault.permissions!.send = 'Signature';
    expect(() => validateMigrationBundle(changed)).toThrow('Noncanonical vault permission: send');
  });

  it('rejects a snapshot with another installed VK', () => {
    const swapped = request();
    swapped.accounts.vault.verificationKey!.hash = '999';
    expect(() => validateMigrationBundle(swapped)).toThrow('matching vault and fee payer snapshots');
  });
});
