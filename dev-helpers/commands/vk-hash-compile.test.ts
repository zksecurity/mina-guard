import { afterEach, describe, expect, test } from 'bun:test';
import { Mina } from 'o1js';
import { configureVkNetwork } from './vk-hash-compile';

const originalNetwork = Mina.activeInstance;
afterEach(() => Mina.setActiveInstance(originalNetwork));

describe('verification key compiler network', () => {
  for (const network of ['mainnet', 'testnet', 'devnet'] as const) {
    test(`uses ${network} for o1js compilation`, () => {
      configureVkNetwork(network);
      expect(Mina.getNetworkId()).toBe(network);
    });
  }
});
