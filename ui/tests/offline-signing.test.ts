import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildOfflineApproveBundle,
  buildOfflineExecuteBundle,
  buildOfflineProposeBundle,
  type OfflineApproveBundle,
} from '../lib/offline-signing';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalNetwork = process.env.NEXT_PUBLIC_MINA_NETWORK;
const endpoint = 'https://configured-node.example/graphql';
let fetchedUrls: string[];

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  if (originalNetwork === undefined) delete process.env.NEXT_PUBLIC_MINA_NETWORK;
  else process.env.NEXT_PUBLIC_MINA_NETWORK = originalNetwork;
});

function configure(networkId: string | undefined) {
  // Runtime desktop configuration must be checked even if a testnet UI was built.
  process.env.NEXT_PUBLIC_MINA_NETWORK = 'testnet';
  globalThis.window = {
    __minaGuardConfig: {
      networkId,
      minaEndpoint: endpoint,
      archiveEndpoint: 'https://configured-archive.example/graphql',
    },
  } as unknown as Window & typeof globalThis;
  fetchedUrls = [];
  globalThis.fetch = (async (url, init) => {
    fetchedUrls.push(String(url));
    if (init?.method === 'POST') {
      const { variables } = JSON.parse(String(init.body));
      return Response.json({ data: { account: { publicKey: variables.publicKey } } });
    }
    return Response.json([]);
  }) as typeof fetch;
}

const proposal: OfflineApproveBundle['proposal'] = {
  proposalHash: '1', proposer: null, toAddress: null, tokenId: null,
  txType: 'transfer', data: null, nonce: '0', configNonce: '0', expirySlot: null,
  guardAddress: 'vault', destination: null, childAccount: null, memoHash: null,
  receivers: [],
};
const common = { contractAddress: 'vault', feePayerAddress: 'payer' };
const builders = [
  { action: 'propose', build: () => buildOfflineProposeBundle({
    ...common, input: { txType: 'transfer', nonce: 0 }, configNonce: 0,
  }) },
  { action: 'approve', build: () => buildOfflineApproveBundle({ ...common, proposal }) },
  { action: 'execute', build: () => buildOfflineExecuteBundle({ ...common, proposal }) },
];

describe('v1 offline bundle network selection', () => {
  for (const { action, build } of builders) {
    it(`${action}: maps devnet to testnet without changing the snapshot endpoint`, async () => {
      configure('devnet');
      const bundle = await build();
      expect(bundle.version).toBe(1);
      expect(bundle.minaNetwork).toBe('testnet');
      expect(fetchedUrls.filter((url) => url === endpoint)).toHaveLength(2);
    });

    it(`${action}: preserves mainnet and testnet`, async () => {
      for (const network of ['mainnet', 'testnet'] as const) {
        configure(network);
        expect((await build()).minaNetwork).toBe(network);
      }
    });

    it(`${action}: rejects unknown runtime networks before fetching`, async () => {
      for (const network of [undefined, '', 'mainet', 'Mainnet', 'zeko:testnet']) {
        configure(network);
        await expect(build()).rejects.toThrow('Unsupported offline signing network');
        expect(fetchedUrls).toHaveLength(0);
      }
    });
  }
});
