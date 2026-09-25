import { describe, expect, it } from 'bun:test';
import { matchesDeploymentNetwork } from '../lib/network-match.ts';

describe('wallet and deployment network matching', () => {
  it('requires an exact match, including devnet versus testnet', () => {
    for (const network of ['mainnet', 'testnet', 'devnet']) {
      expect(matchesDeploymentNetwork(network, network)).toBe(true);
    }
    expect(matchesDeploymentNetwork('devnet', 'testnet')).toBe(false);
    expect(matchesDeploymentNetwork('testnet', 'devnet')).toBe(false);
    expect(matchesDeploymentNetwork('testnet', 'mainnet')).toBe(false);
    expect(matchesDeploymentNetwork(null, 'testnet')).toBe(false);
  });
});
