import { afterEach, describe, expect, it } from 'bun:test';
import { assertMinaNodeNetwork, resolveCreateVaultNetwork } from '../lib/create-vault-network';
import type { MinaGuardConfig } from '../types/mina-guard-config';

const originalFetch = globalThis.fetch;
const mainnetBuild = {
  network: 'mainnet',
  minaEndpoint: 'https://mina.example/graphql',
  archiveEndpoint: 'https://archive.example/graphql',
  expectedVkHash: '123456789',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Create Vault network', () => {
  it('does not offer mainnet from a testnet or invalid build', () => {
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, network: 'testnet' }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, network: undefined }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, network: 'mainet' }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, network: 'testnet' }, 'testnet')).toBe('testnet');
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, network: 'testnet' }, 'devnet')).toBe('devnet');
  });

  it('offers mainnet only with explicit HTTPS endpoints and expected VK hash', () => {
    expect(resolveCreateVaultNetwork(mainnetBuild, 'mainnet')).toBe('mainnet');
    expect(resolveCreateVaultNetwork(mainnetBuild, 'testnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, minaEndpoint: undefined }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, archiveEndpoint: undefined }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, minaEndpoint: 'http://mina.example/graphql' }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, expectedVkHash: undefined }, 'mainnet')).toBeNull();
    expect(resolveCreateVaultNetwork({ ...mainnetBuild, expectedVkHash: '0' }, 'mainnet')).toBeNull();
  });
});

const config: MinaGuardConfig = {
  networkId: 'mainnet',
  minaEndpoint: 'https://mina.example/graphql',
  archiveEndpoint: 'https://archive.example/graphql',
};

function nodeReports(networkID: unknown, errors?: unknown) {
  let requestedUrl = '';
  let requestedQuery = '';
  globalThis.fetch = (async (url, init) => {
    requestedUrl = String(url);
    requestedQuery = JSON.parse(String(init?.body)).query;
    return Response.json({ data: { networkID }, ...(errors ? { errors } : {}) });
  }) as typeof fetch;
  return { get url() { return requestedUrl; }, get query() { return requestedQuery; } };
}

describe('Create Vault node identity check', () => {
  it('accepts a mainnet node for a mainnet build', async () => {
    const request = nodeReports('mina:mainnet');
    await assertMinaNodeNetwork(config);
    expect(request.url).toBe(config.minaEndpoint);
    expect(request.query).toBe('{ networkID }');
  });

  it('accepts either test-network label for the shared proof domain', async () => {
    nodeReports('mina:devnet');
    await assertMinaNodeNetwork({ ...config, networkId: 'testnet' });
    nodeReports('mina:testnet');
    await assertMinaNodeNetwork({ ...config, networkId: 'devnet' });
  });

  it('rejects cross-domain and absent network identities', async () => {
    nodeReports('mina:devnet');
    await expect(assertMinaNodeNetwork(config)).rejects.toThrow('network mismatch');
    nodeReports('mina:mainnet');
    await expect(assertMinaNodeNetwork({ ...config, networkId: 'testnet' })).rejects.toThrow('network mismatch');
    nodeReports(undefined);
    await expect(assertMinaNodeNetwork(config)).rejects.toThrow('supported network ID');
    nodeReports('zeko:mainnet');
    await expect(assertMinaNodeNetwork(config)).rejects.toThrow('supported network ID');
  });

  it('rejects a GraphQL error even if data contains a network ID', async () => {
    nodeReports('mina:mainnet', [{ message: 'partial result' }]);
    await expect(assertMinaNodeNetwork(config)).rejects.toThrow('supported network ID');
  });
});
