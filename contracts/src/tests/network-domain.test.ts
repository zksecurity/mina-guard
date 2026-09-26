import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { NETWORK_DOMAIN_IDS, resolveNetworkDomain } from '../network-domain.js';

describe('compile-time network domain selection', () => {
  it('keeps mainnet separate and the existing testnet/devnet proposal domain', () => {
    expect(NETWORK_DOMAIN_IDS.mainnet).toBe(1n);
    expect(NETWORK_DOMAIN_IDS.testnet).toBe(2n);
    expect(NETWORK_DOMAIN_IDS.devnet).toBe(2n);
  });

  it('requires an explicit, exact network name', () => {
    for (const invalid of [undefined, '', 'mainet', 'Mainnet', 'production']) {
      expect(() => resolveNetworkDomain(invalid, undefined)).toThrow();
      expect(() => resolveNetworkDomain(undefined, invalid)).toThrow();
    }
  });

  it('rejects conflicting browser and Node selections', () => {
    expect(() => resolveNetworkDomain('testnet', 'mainnet')).toThrow('disagree');
  });

  it('accepts each valid domain from either build context', () => {
    for (const network of ['mainnet', 'testnet', 'devnet'] as const) {
      expect(resolveNetworkDomain(network, undefined)).toBe(network);
      expect(resolveNetworkDomain(undefined, network)).toBe(network);
      expect(resolveNetworkDomain(network, network)).toBe(network);
    }
  });

  it('selects the browser network when importing the contract constants', () => {
    const constantsUrl = new URL('../constants.ts', import.meta.url).href;
    const env = { ...process.env, NEXT_PUBLIC_MINA_NETWORK: 'mainnet' };
    delete env.MINA_NETWORK_DOMAIN;
    const result = spawnSync(process.execPath, ['-e', `
      import { NETWORK_DOMAIN_NAME, NETWORK_DOMAIN } from '${constantsUrl}';
      console.log(NETWORK_DOMAIN_NAME, NETWORK_DOMAIN.toString());
    `], {
      cwd: new URL('../../..', import.meta.url).pathname,
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('mainnet 1');
  });

  it('rejects conflicting browser and Node environments at contract import', () => {
    const constantsUrl = new URL('../constants.ts', import.meta.url).href;
    const result = spawnSync(process.execPath, ['-e', `import '${constantsUrl}';`], {
      cwd: new URL('../../..', import.meta.url).pathname,
      env: { ...process.env, NEXT_PUBLIC_MINA_NETWORK: 'mainnet', MINA_NETWORK_DOMAIN: 'testnet' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('NEXT_PUBLIC_MINA_NETWORK and MINA_NETWORK_DOMAIN disagree');
  });

  it('separates mainnet from the shared testnet/devnet proposal hash', () => {
    const constantsUrl = new URL('../constants.ts', import.meta.url).href;
    const script = `
      import { Field, Poseidon } from 'o1js';
      import { NETWORK_DOMAIN } from '${constantsUrl}';
      console.log(Poseidon.hash([Field(42), NETWORK_DOMAIN]).toString());
    `;
    const hashes = ['mainnet', 'testnet', 'devnet'].map((network) => {
      const env = { ...process.env, MINA_NETWORK_DOMAIN: network };
      delete env.NEXT_PUBLIC_MINA_NETWORK;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: new URL('../../..', import.meta.url).pathname,
        env,
        encoding: 'utf8',
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    });
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);
  });

  it('keeps the selected domain fixed after module initialization', () => {
    const constantsUrl = new URL('../constants.ts', import.meta.url).href;
    const script = `
      import { NETWORK_DOMAIN_NAME } from '${constantsUrl}';
      process.env.MINA_NETWORK_DOMAIN = 'mainnet';
      console.log(NETWORK_DOMAIN_NAME);
    `;
    const env = { ...process.env, MINA_NETWORK_DOMAIN: 'testnet' };
    delete env.NEXT_PUBLIC_MINA_NETWORK;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: new URL('../../..', import.meta.url).pathname,
      env,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.stdout.trim()).toBe('testnet');
  });
});
