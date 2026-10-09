import { afterEach, describe, expect, it } from 'bun:test';
import { GUARD_PERMISSION_KINDS, GUARD_SET_VERIFICATION_KEY_TXN_VERSION } from 'contracts/guard-permission-policy';
import { fetchVaultSecurityStatus, isCanonicalVaultSecurity } from '../lib/api';

const originalFetch = globalThis.fetch;
const originalHash = process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH;
const originalE2e = process.env.NEXT_PUBLIC_E2E_TEST;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHash === undefined) delete process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH;
  else process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH = originalHash;
  if (originalE2e === undefined) delete process.env.NEXT_PUBLIC_E2E_TEST;
  else process.env.NEXT_PUBLIC_E2E_TEST = originalE2e;
});

function mockAccount(version: string, hash = 'reviewed-vk', overrides: Record<string, unknown> = {}) {
  process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH = 'reviewed-vk';
  delete process.env.NEXT_PUBLIC_E2E_TEST;
  globalThis.fetch = (async () => Response.json({ data: { account: {
    verificationKey: { hash },
    permissions: {
      ...GUARD_PERMISSION_KINDS,
      setVerificationKey: { auth: 'Impossible', txnVersion: version },
      ...overrides,
    },
  } } })) as unknown as typeof fetch;
}

describe('same VK after a transaction-version upgrade', () => {
  const current = BigInt(GUARD_SET_VERIFICATION_KEY_TXN_VERSION);

  it('keeps the version mismatch visible while allowing ordinary proved actions', async () => {
    mockAccount(String(current - 1n));
    const status = await fetchVaultSecurityStatus('vault');
    expect(status?.permissionMismatches).toEqual(['setVerificationKey']);
    expect(status?.setVerificationKeyTxnVersion).toBe(String(current - 1n));
    expect(isCanonicalVaultSecurity(status)).toBe(true);
  });

  it('still blocks a different VK, future version, or changed permission kind', async () => {
    mockAccount(String(current - 1n), 'other-vk');
    expect(isCanonicalVaultSecurity(await fetchVaultSecurityStatus('vault'))).toBe(false);
    mockAccount(String(current + 1n));
    expect(isCanonicalVaultSecurity(await fetchVaultSecurityStatus('vault'))).toBe(false);
    mockAccount(String(current - 1n), 'reviewed-vk', { send: 'Signature' });
    expect(isCanonicalVaultSecurity(await fetchVaultSecurityStatus('vault'))).toBe(false);
    mockAccount(String(current - 1n), 'reviewed-vk', { access: undefined });
    expect(isCanonicalVaultSecurity(await fetchVaultSecurityStatus('vault'))).toBe(false);
  });
});
