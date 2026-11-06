import { afterEach, describe, expect, it } from 'bun:test';
import { fetchVaultSecurityStatus, isCanonicalVaultSecurity, vaultSecurityError } from '../lib/api';

const originalFetch = globalThis.fetch;
const originalE2e = process.env.NEXT_PUBLIC_E2E_TEST;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalE2e === undefined) delete process.env.NEXT_PUBLIC_E2E_TEST;
  else process.env.NEXT_PUBLIC_E2E_TEST = originalE2e;
});

function mockFetch(respond: () => Response | Promise<Response>) {
  delete process.env.NEXT_PUBLIC_E2E_TEST;
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
}

describe('node unavailable during the vault security check', () => {
  it('returns null, and stays blocked, for a gateway error, GraphQL errors, or a network failure', async () => {
    mockFetch(() => new Response('Upstream unavailable', { status: 502 }));
    expect(await fetchVaultSecurityStatus('vault')).toBeNull();
    mockFetch(() => Response.json({ errors: [{ message: 'daemon not ready' }] }));
    expect(await fetchVaultSecurityStatus('vault')).toBeNull();
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    expect(await fetchVaultSecurityStatus('vault')).toBeNull();
    expect(isCanonicalVaultSecurity(null)).toBe(false);
  });

  it('reports a missing account as a real result, not an outage', async () => {
    mockFetch(() => Response.json({ data: { account: null } }));
    const status = await fetchVaultSecurityStatus('vault');
    expect(status?.accountFound).toBe(false);
    expect(isCanonicalVaultSecurity(status)).toBe(false);
  });

  it('names the node, not the Vault, when the check could not run', () => {
    expect(vaultSecurityError(true)).toBe(
      "Could not reach the Mina node to check the Vault's permissions; try again in a minute",
    );
    expect(vaultSecurityError(true, 'SubVault')).toContain("the SubVault's permissions");
    expect(vaultSecurityError(false)).toBe('Vault permissions have not passed the canonical security check');
    expect(vaultSecurityError(false, 'Parent Vault')).toBe(
      'Parent Vault permissions have not passed the canonical security check',
    );
  });
});
