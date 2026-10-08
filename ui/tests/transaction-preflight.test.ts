import { describe, expect, test } from 'bun:test';
import { checkTransactionState, nodeAccountReader } from '../lib/transaction-preflight';
import { classifyDeployTarget } from '../lib/deploy-target';
import { AccountUpdate, Bool, Field, PrivateKey, TokenId, fetchAccount } from 'o1js';
function update(publicKey: string, state: Array<string | null>, appState = state.map(() => null) as Array<string | null>, tokenId = '1') {
  return { body: { publicKey, tokenId, preconditions: { account: { state, isNew: null as boolean | null } }, update: { appState } } };
}
const tx = (...accountUpdates: unknown[]) => JSON.stringify({ accountUpdates });
describe('pre-broadcast state check', () => {
  test('checks only constrained slots; changed roots stop', async () => {
    expect((await checkTransactionState(tx(update('vault', [null, '2'])), async () => ['99', '2'])).status).toBe('current');
    expect((await checkTransactionState(tx(update('vault', [null, '2'])), async () => ['99', '3'])).status).toBe('stale');
  });
  test('checks foreign parent/child accounts and token IDs independently', async () => {
    const seen: string[] = [];
    const result = await checkTransactionState(tx(update('parent', ['1']), update('child', ['2'], [null], '42')), async (address, token) => {
      seen.push(`${address}:${token}`); return address === 'parent' ? ['1'] : ['3'];
    });
    expect(result.status).toBe('stale'); expect(seen).toEqual(['parent:1', 'child:42']);
  });
  test('evaluates repeated updates against preceding in-transaction writes', async () => {
    let reads = 0;
    const result = await checkTransactionState(tx(update('vault', ['1'], ['2']), update('vault', ['2'], ['3'])), async () => { reads++; return ['1']; });
    expect(result.status).toBe('current'); expect(reads).toBe(1);
  });
  test('allows absent accounts only with explicit isNew', async () => {
    const item = update('new', ['0'], ['1']);
    expect((await checkTransactionState(tx(item), async () => null)).status).toBe('stale');
    item.body.preconditions.account.isNew = true;
    expect((await checkTransactionState(tx(item), async () => null)).status).toBe('current');
  });
  test('handles an unconstrained deployment followed by setup in the same transaction', async () => {
    const result = await checkTransactionState(tx(update('new', [null, null], ['0', '7']), update('new', ['0', '7'], ['1', '8'])), async () => null);
    expect(result.status).toBe('current');
  });
  test('fails closed on malformed transaction, incomplete state and outage', async () => {
    for (const json of ['{}', '{', tx(update('vault', ['bad'])), tx(update('vault', ['1']))]) {
      expect((await checkTransactionState(json, async () => [])).status).toBe('unavailable');
    }
    expect((await checkTransactionState(tx(update('vault', ['1'])), async () => { throw new Error('offline'); })).status).toBe('unavailable');
  });
  test('accepts real o1js JSON and does not alter it', async () => {
    const au = AccountUpdate.create(PrivateKey.random().toPublicKey());
    au.body.preconditions.account.state[4] = { isSome: Bool(true), value: Field(10) };
    au.body.update.appState[4] = { isSome: Bool(true), value: Field(11) };
    const json = tx(AccountUpdate.toJSON(au));
    const result = await checkTransactionState(json, async (_, token) => {
      expect(token).toBe(TokenId.toBase58(au.body.tokenId));
      const fields = Array(au.body.update.appState.length).fill('0'); fields[4] = '10'; return fields;
    });
    expect(result.status).toBe('current'); expect(json).toBe(tx(AccountUpdate.toJSON(au)));
  });
  test('reads a bare account as zeros; only an isNew precondition on it is stale', async () => {
    const bare = async () => 'bare' as const;
    expect((await checkTransactionState(tx(update('vault', [null, null], ['0', '7']), update('vault', ['0', '7'], ['1', '8'])), bare)).status).toBe('current');
    expect((await checkTransactionState(tx(update('vault', ['0'], ['1'])), bare)).status).toBe('current');
    expect((await checkTransactionState(tx(update('vault', ['5'])), bare)).status).toBe('stale');
    const item = update('vault', [null], ['1']);
    item.body.preconditions.account.isNew = true;
    expect((await checkTransactionState(tx(item), bare)).status).toBe('stale');
  });
  test('node reader bypasses caches, tells absent from bare, and rejects incomplete/error responses', async () => {
    const original = globalThis.fetch;
    const serve = (payload: unknown) => {
      globalThis.fetch = (async (_url, init) => { expect(init?.cache).toBe('no-store'); return new Response(JSON.stringify(payload)); }) as typeof fetch;
    };
    try {
      for (const payload of [{ errors: [{ message: 'unavailable' }] }, { data: {} }, { data: { account: {} } }, { data: { account: { zkappState: '7' } } }]) {
        serve(payload);
        await expect(nodeAccountReader('http://node')('vault', '1')).rejects.toThrow();
      }
      serve({ data: { account: null } });
      expect(await nodeAccountReader('http://node')('vault', '1')).toBeNull();
      serve({ data: { account: { zkappState: null } } });
      expect(await nodeAccountReader('http://node')('vault', '1')).toBe('bare');
      serve({ data: { account: { zkappState: ['1', '2'] } } });
      expect(await nodeAccountReader('http://node')('vault', '1')).toEqual(['1', '2']);
    } finally { globalThis.fetch = original; }
  });
  test('a deployment into a bare account passes the target check and the state check from one node answer', async () => {
    const address = PrivateKey.random().toPublicKey();
    // What the node answers for an account a plain payment created: every zkApp field is null.
    const bareAccount = {
      publicKey: address.toBase58(), token: TokenId.toBase58(TokenId.default), nonce: '0', balance: { total: '1000000000' },
      tokenSymbol: '', receiptChainHash: null, delegateAccount: null, votingFor: null, permissions: null,
      timing: { initialMinimumBalance: null, cliffTime: null, cliffAmount: null, vestingPeriod: null, vestingIncrement: null },
      zkappState: null, verificationKey: null, actionState: null, provedState: null, zkappUri: null,
    };
    const deploy = AccountUpdate.create(address);
    deploy.body.update.appState[0] = { isSome: Bool(true), value: Field(7) };
    const setup = AccountUpdate.create(address);
    setup.body.preconditions.account.state[0] = { isSome: Bool(true), value: Field(7) };
    setup.body.update.appState[0] = { isSome: Bool(true), value: Field(8) };
    const json = tx(AccountUpdate.toJSON(deploy), AccountUpdate.toJSON(setup));
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: { account: bareAccount } }))) as unknown as typeof fetch;
      expect(classifyDeployTarget(await fetchAccount({ publicKey: address }, 'http://node'))).toBe('existing');
      expect((await checkTransactionState(json, nodeAccountReader('http://node'))).status).toBe('current');
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: { account: {} } }))) as unknown as typeof fetch;
      expect((await checkTransactionState(json, nodeAccountReader('http://node'))).status).toBe('unavailable');
    } finally { globalThis.fetch = original; }
  });
});
