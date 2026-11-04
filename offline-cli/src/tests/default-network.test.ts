import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const DEFAULT_NETWORK = join(import.meta.dirname, '..', 'default-network.ts');

/** The circuit domain 'contracts' resolves after the CLI's first import. */
function domainWith(env: Record<string, string>): { out: string; err: string } {
  const { MINA_NETWORK_DOMAIN: _a, NEXT_PUBLIC_MINA_NETWORK: _b, ...base } = process.env;
  const script = `await import(${JSON.stringify(DEFAULT_NETWORK)});` +
    "const { NETWORK_DOMAIN_NAME } = await import('contracts'); console.log(NETWORK_DOMAIN_NAME);";
  const result = spawnSync('bun', ['-e', script], {
    cwd: join(import.meta.dirname, '..', '..'), env: { ...base, ...env }, encoding: 'utf8',
  });
  return { out: result.stdout.trim(), err: result.stderr };
}

describe('offline CLI network domain', () => {
  it('defaults to mainnet when no domain is set', () => {
    expect(domainWith({}).out).toBe('mainnet');
  });

  it('keeps an explicit test network', () => {
    expect(domainWith({ MINA_NETWORK_DOMAIN: 'testnet' }).out).toBe('testnet');
    expect(domainWith({ MINA_NETWORK_DOMAIN: 'devnet' }).out).toBe('devnet');
  });

  it('still rejects an invalid explicit domain', () => {
    const result = domainWith({ MINA_NETWORK_DOMAIN: 'mainnnet' });
    expect(result.out).toBe('');
    expect(result.err).toContain('MINA_NETWORK_DOMAIN');
  });
});
