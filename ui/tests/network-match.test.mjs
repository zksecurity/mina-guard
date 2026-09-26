import { describe, expect, it } from 'bun:test';
import { matchesDeploymentNetwork } from '../lib/network-match.ts';
import { getAuroNetwork } from '../lib/auroWallet.ts';

describe('wallet and deployment network matching', () => {
  it('accepts both Mina test-network wallet labels, but not other chains', () => {
    expect(matchesDeploymentNetwork('mina:mainnet', 'mainnet')).toBe(true);
    for (const deployment of ['testnet', 'devnet']) {
      expect(matchesDeploymentNetwork('mina:testnet', deployment)).toBe(true);
      expect(matchesDeploymentNetwork('mina:devnet', deployment)).toBe(true);
      expect(matchesDeploymentNetwork('zeko:testnet', deployment)).toBe(false);
      expect(matchesDeploymentNetwork('testnet', deployment)).toBe(false);
    }
    expect(matchesDeploymentNetwork('mina:devnet', 'mainnet')).toBe(false);
    expect(matchesDeploymentNetwork('mina:mainnet', 'testnet')).toBe(false);
    expect(matchesDeploymentNetwork('mina:devnet', 'unknown')).toBe(false);
    expect(matchesDeploymentNetwork(null, 'testnet')).toBe(false);
  });

  it('keeps the Auro namespace instead of reducing zeko:testnet to testnet', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { mina: { requestNetwork: async () => ({ networkID: 'zeko:testnet' }) } };
    try {
      expect(await getAuroNetwork()).toBe('zeko:testnet');
      expect(matchesDeploymentNetwork(await getAuroNetwork(), 'testnet')).toBe(false);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
