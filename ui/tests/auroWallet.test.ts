import { afterEach, describe, expect, it } from 'bun:test';
import { getAuroNetwork } from '../lib/auroWallet';

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

describe('Auro short network names', () => {
  for (const network of ['mainnet', 'testnet', 'devnet']) {
    it(`preserves ${network} for labels, faucets, and explorer links`, async () => {
      globalThis.window = {
        mina: { requestNetwork: async () => ({ networkID: `mina:${network}` }) },
      } as unknown as Window & typeof globalThis;
      expect(await getAuroNetwork()).toBe(network);
    });
  }

  it('returns null if the provider is absent', async () => {
    globalThis.window = {} as Window & typeof globalThis;
    expect(await getAuroNetwork()).toBeNull();
  });

  it('returns null if the network query fails', async () => {
    globalThis.window = {
      mina: { requestNetwork: async () => { throw new Error('locked'); } },
    } as unknown as Window & typeof globalThis;
    expect(await getAuroNetwork()).toBeNull();
  });
});
