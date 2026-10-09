import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import type { StoreCheckpoint } from 'contracts';

let configuredNetwork: string | undefined;
let checkpointCalls: string[] = [];
mock.module('../lib/multisigClient', () => ({
  computeCreateChildConfigHash: async () => ({ configHash: 'approved-config' }),
  exportStoreCheckpoint: async (address: string): Promise<StoreCheckpoint> => {
    checkpointCalls.push(address);
    return {
      version: 1, network: configuredNetwork === 'mainnet' ? 'mainnet' : 'testnet',
      address, throughBlock: null, owners: '{"owners":[]}',
      approvals: '{"entries":{"entries":{}}}', nullifiers: '{"keys":[]}',
      roots: { ownersCommitment: '1', approvalRoot: '2', voteNullifierRoot: '3' },
    };
  },
}));
afterAll(() => mock.restore());
import type { OfflineApproveBundle } from '../lib/offline-signing';
const { buildOfflineApproveBundle, buildOfflineExecuteBundle, buildOfflineProposeBundle } =
  await import('../lib/offline-signing');

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
  configuredNetwork = networkId;
  checkpointCalls = [];
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
      return Response.json({ data: { account: { publicKey: variables.publicKey, nonce: '0', balance: { total: '1000000000' }, zkappState: null } } });
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

describe('offline bundle network selection', () => {
  for (const { action, build } of builders) {
    it(`${action}: maps devnet to testnet without changing the snapshot endpoint`, async () => {
      configure('devnet');
      const bundle = await build();
      expect(bundle.version).toBe(2);
      expect(bundle.events).toEqual([]);
      expect(bundle.storeCheckpoint.network).toBe('testnet');
      expect(checkpointCalls).toEqual(['vault']);
      expect(bundle.minaNetwork).toBe('testnet');
      expect(fetchedUrls.filter((url) => url === endpoint)).toHaveLength(2);
    });

    it(`${action}: preserves mainnet and testnet`, async () => {
      for (const network of ['mainnet', 'testnet'] as const) {
        configure(network);
        const bundle = await build();
        expect(bundle.minaNetwork).toBe(network);
        expect(bundle.storeCheckpoint.network).toBe(network);
        expect(checkpointCalls).toEqual(['vault']);
      }
    });

    it(`${action}: rejects unknown runtime networks before worker access or fetching`, async () => {
      for (const network of [undefined, '', 'mainet', 'Mainnet', 'zeko:testnet']) {
        configure(network);
        await expect(build()).rejects.toThrow('Unsupported offline signing network');
        expect(fetchedUrls).toHaveLength(0);
        expect(checkpointCalls).toHaveLength(0);
      }
    });
  }
});

describe('offline allocation snapshots', () => {
  it('exports each recipient account for offline child-state preconditions', async () => {
    configure('testnet');
    const bundle = await buildOfflineExecuteBundle({
      ...common,
      proposal: { ...proposal, txType: 'allocateChild', receivers: [
        { address: 'child-a', amount: '100' },
        { address: 'child-b', amount: '200' },
        { address: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG', amount: '0' },
      ] },
    });
    expect(Object.keys(bundle.accounts).sort()).toEqual(['child-a', 'child-b', 'payer', 'vault']);
    expect(bundle.accounts['child-a'].publicKey).toBe('child-a');
    expect(bundle.receiverAccountExists).toEqual({ 'child-a': true, 'child-b': true });
  });
});

describe('account snapshots', () => {
  it('fails the export when the node answers with an error instead of an account', async () => {
    configure('testnet');
    globalThis.fetch = (async (url, init) => {
      if (init?.method === 'POST') return Response.json({ errors: [{ message: 'node busy' }] });
      return Response.json([]);
    }) as typeof fetch;
    await expect(buildOfflineApproveBundle({ ...common, proposal })).rejects.toThrow('Could not fetch account');
  });

  it('fails the export when an account answer lacks the fields the CLI decides from', async () => {
    configure('testnet');
    globalThis.fetch = (async (url, init) => {
      if (init?.method === 'POST') return Response.json({ data: { account: { publicKey: 'vault' } } });
      return Response.json([]);
    }) as typeof fetch;
    await expect(buildOfflineApproveBundle({ ...common, proposal })).rejects.toThrow('Incomplete account snapshot');
  });
});

describe('CREATE_CHILD approve bundles', () => {
  const CHILD = 'B62qchildAddressForReservation';
  const OWNERS = ['B62qownerAddressOne', 'B62qownerAddressTwo'];
  const reservation = [
    { eventType: 'createChildConfig', payload: { childAccount: CHILD, threshold: '1', numOwners: '2' } },
    { eventType: 'createChildOwner', payload: { owner: OWNERS[0], index: '0' } },
    { eventType: 'createChildOwner', payload: { owner: OWNERS[1], index: '1' } },
  ];
  const createChild = (data: string) => ({ ...proposal, txType: 'createChild', childAccount: CHILD, data });

  /** The child's own events hold its reservation; the mocked hash of any config is 'approved-config'. */
  function serveChildEvents(events: unknown[]) {
    configure('testnet');
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes(`/api/contracts/${CHILD}/events`)) return Response.json(events);
      return inner(url, init);
    }) as typeof fetch;
  }

  it('carries the reserved owners and threshold that hash to the signed data', async () => {
    serveChildEvents(reservation);
    const bundle = await buildOfflineApproveBundle({ ...common, proposal: createChild('approved-config') });
    expect(bundle.childAddress).toBe(CHILD);
    expect(bundle.childOwners).toEqual(OWNERS);
    expect(bundle.childThreshold).toBe(1);
  });

  it('refuses to export when the reservation is missing or does not match', async () => {
    serveChildEvents([]);
    await expect(buildOfflineApproveBundle({ ...common, proposal: createChild('approved-config') }))
      .rejects.toThrow('SubVault config events not found');
    serveChildEvents(reservation);
    await expect(buildOfflineApproveBundle({ ...common, proposal: createChild('another-config') }))
      .rejects.toThrow('does not match the parent-approved proposal data');
  });

  it('leaves other approvals without a SubVault config', async () => {
    configure('testnet');
    const bundle = await buildOfflineApproveBundle({ ...common, proposal });
    expect(bundle.childOwners).toBeUndefined();
  });
});
