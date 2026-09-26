import { describe, expect, it } from 'bun:test';
import { matchesBuildProofDomain, parseNodeNetworkId } from '../src/network-id.js';

describe('Mina node network identity', () => {
  it('accepts exact supported network IDs', () => {
    for (const network of ['mainnet', 'testnet', 'devnet'] as const) {
      expect(parseNodeNetworkId(network)).toBe(network);
      expect(parseNodeNetworkId(`mina:${network}`)).toBe(network);
    }
  });

  it('rejects absent, malformed, and misleading identities', () => {
    for (const value of [undefined, null, '', 'mina:', 'mina:mainnet-testnet', 'other:testnet', 'lightnet']) {
      expect(() => parseNodeNetworkId(value)).toThrow('networkID');
    }
  });

  it('shares the test proof domain without crossing into mainnet', () => {
    expect(matchesBuildProofDomain('devnet', 'testnet')).toBe(true);
    expect(matchesBuildProofDomain('testnet', 'devnet')).toBe(true);
    expect(matchesBuildProofDomain('mainnet', 'testnet')).toBe(false);
  });
});
