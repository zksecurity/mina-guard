import { afterAll, describe, expect, it, mock } from 'bun:test';

const calls: string[] = [];
const checkpoint = { version: 1, network: 'testnet', address: 'vault', throughBlock: null,
  owners: '{"owners":[]}', approvals: '{"entries":{"entries":{}}}', nullifiers: '{"keys":[]}',
  roots: { ownersCommitment: '1', approvalRoot: '2', voteNullifierRoot: '3' } };
mock.module('../../ui/lib/multisigClient', () => ({
  exportStoreCheckpoint: async (address: string) => {
    calls.push(`checkpoint:${address}`);
    return checkpoint;
  },
}));
const { buildOfflineProposeBundle, buildOfflineApproveBundle, buildOfflineExecuteBundle } = await import('../../ui/lib/offline-signing');
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; mock.restore(); });

const proposal = {
  proposalHash: '100', proposer: 'owner', toAddress: null, tokenId: '0', txType: 'transfer', data: '0',
  nonce: '1', configNonce: '0', expirySlot: '0', guardAddress: 'vault', destination: '0',
  childAccount: null, memoHash: '0', receivers: [],
};

describe('offline checkpoint export', () => {
  it('exports v2 snapshots for propose, approve and execute without a second vault history fetch', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/events')) throw new Error('Unexpected full history request');
      const address = JSON.parse(String(init?.body)).variables.publicKey;
      calls.push(`account:${address}`);
      return Response.json({ data: { account: { publicKey: address, zkappState: [] } } });
    }) as typeof fetch;
    const params = { contractAddress: 'vault', feePayerAddress: 'owner' };
    const builders = [
      () => buildOfflineProposeBundle({ ...params, input: { txType: 'transfer', nonce: 1 }, configNonce: 0 }),
      () => buildOfflineApproveBundle({ ...params, proposal }),
      () => buildOfflineExecuteBundle({ ...params, proposal }),
    ];
    for (const build of builders) {
      calls.length = 0;
      const bundle = await build();
      expect(bundle.version).toBe(2);
      expect(bundle.events).toEqual([]);
      expect(bundle.storeCheckpoint).toEqual(checkpoint);
      expect(bundle.contractAddress).toBe('vault');
      expect(bundle.minaNetwork).toBe('testnet');
      expect(calls[0]).toBe('checkpoint:vault');
      expect(calls).toHaveLength(3);
    }
  });
});
