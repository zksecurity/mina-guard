/** Real worker + LocalBlockchain regression. Proving/compilation and external I/O are test-only stubs. */
import { expect, mock } from 'bun:test';
process.env.MINA_NETWORK_DOMAIN = 'testnet';
process.env.NEXT_PUBLIC_MINA_NETWORK = 'testnet';
process.env.NEXT_PUBLIC_E2E_TEST = 'true';

const real = await import('o1js');
const { setupLocalBlockchain, deployAndSetup, createAddOwnerProposal, proposeTransaction } = await import('../../contracts/build/src/tests/test-helpers.js');
const { memoToField, PROPOSED_MARKER } = await import('contracts');
const ctx = await setupLocalBlockchain(3);
await deployAndSetup(ctx, 2);
const local = real.Mina.activeInstance;

// The worker's normal network initialization uses this owned local ledger.
mock.module('o1js', () => ({ ...real, Mina: { ...real.Mina, Network: () => local }, fetchAccount: async () => ({}) }));
let api: import('../../ui/lib/multisigClient.worker').WorkerApi;
mock.module('mina-signer', () => ({ default: class {} }));
mock.module('comlink', () => ({ expose: (value: typeof api) => { api = value; } }));
let events: Array<{ eventType: string; payload: Record<string, string>; blockHeight: number }> = ctx.owners.map((owner, index) => ({
  eventType: 'setupOwner', payload: { owner: owner.pub.toBase58(), index: String(index) }, blockHeight: 1,
}));
mock.module('../../ui/lib/api', () => ({ fetchAllEvents: async (_address: string, fromBlock?: number) => events.filter(e => fromBlock === undefined || e.blockHeight >= fromBlock) }));
await import('../../ui/lib/multisigClient.worker');
api!.setConfig({ minaEndpoint: 'http://owned-local-ledger', archiveEndpoint: 'http://owned-local-ledger', networkId: 'testnet' });
api!.setSkipProofs(true);

const newOwner = real.PrivateKey.random().toPublicKey();
const input = { txType: 'addOwner' as const, newOwner: newOwner.toBase58(), nonce: 1, memo: 'same proposal' };
const params = { contractAddress: ctx.zkAppAddress.toBase58(), proposerAddress: ctx.owners[0].pub.toBase58(), input, configNonce: 0 };
const sameProposal = createAddOwnerProposal(newOwner, ctx.owners.map(o => o.pub), real.Field(1), real.Field(0), ctx.zkAppAddress,
  real.Field(0), real.PublicKey.empty(), real.Field(0), memoToField(input.memo));
let signingRequests = 0;
let broadcasts = 0;
const send = async () => { broadcasts++; return 'unexpected-broadcast'; };
const { isStoreStateMismatch } = await import('../../ui/lib/preflight-flow');
const { existingProposalHash } = await import('../../ui/lib/proposal-preparation');
let firstFailure: unknown;
try {
  await api!.createOnchainProposal(params, async fields => {
    signingRequests++;
    // A is waiting for its first wallet signature; B's same proposal is included.
    await proposeTransaction(ctx, sameProposal, 1);
    events.push({ eventType: 'approval', blockHeight: 2, payload: {
      proposalHash: sameProposal.hash().toString(), approver: ctx.owners[1].pub.toBase58(), approvalCount: PROPOSED_MARKER.add(1).toString(),
    } });
    return { data: fields, signature: real.Signature.create(ctx.owners[0].key, fields.map(real.Field)).toBase58() };
  }, send, () => {});
} catch (error) { firstFailure = error; }
expect(isStoreStateMismatch(firstFailure)).toBe(true);
expect(signingRequests).toBe(1);
expect(broadcasts).toBe(0);

// Explicit retry reads the updated events and refuses duplicate creation before signing again.
let secondFailure: unknown;
try { await api!.createOnchainProposal(params, async () => { signingRequests++; return null; }, send, () => {}); }
catch (error) { secondFailure = error; }
expect(existingProposalHash(secondFailure)).toBe(sameProposal.hash().toString());
expect(signingRequests).toBe(1);
expect(broadcasts).toBe(0);
const retry = await api!.assessRetry({ action: 'propose', address: params.contractAddress, actor: params.proposerAddress, input, configNonce: 0 });
expect(retry).toEqual({ status: 'existing', proposalHash: sameProposal.hash().toString() });

// A genuinely different nonce can proceed to its normal signing request.
const cancelled = await api!.createOnchainProposal({ ...params, input: { ...input, nonce: 2 } }, async () => { signingRequests++; return null; }, send, () => {});
expect(cancelled).toBeNull();
expect(signingRequests).toBe(2);
expect(broadcasts).toBe(0);
console.log('PASS: real worker catches a root change during proposal signing; duplicate retry stops before another signature or broadcast; fresh intent remains available (proofless local ledger).');

// Direct E2E signing must return the hash used by proposal status polling,
// without the banner prefix that the UI adds to its own success messages.
let directPreflightChecks = 0;
api!.setPreflightCheck(async () => { directPreflightChecks++; });
api!.setTestKey(ctx.owners[0].key.toBase58());
const submitted = await api!.createOnchainProposal(
  { ...params, input: { ...input, nonce: 2 } },
  async () => { throw new Error('Direct signing must not call the wallet'); },
  send, () => {},
);
expect(directPreflightChecks).toBe(1);
expect(submitted?.proposalHash).toBeTruthy();
expect(submitted?.txHash).toMatch(/^5J[1-9A-HJ-NP-Za-km-z]+$/);
expect(submitted!.txHash).not.toContain('Transaction submitted:');
expect(broadcasts).toBe(0);
console.log('PASS: direct E2E signing returns a bare transaction hash for proposal status polling.');
