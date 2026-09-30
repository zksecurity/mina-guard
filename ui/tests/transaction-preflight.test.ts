import { describe, expect, test } from 'bun:test';
import { checkTransactionState, nodeAccountReader } from '../lib/transaction-preflight';
import { AccountUpdate, Bool, Field, PrivateKey, TokenId } from 'o1js';
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
  test('node reader bypasses caches and rejects incomplete/error responses', async () => {
    const original = globalThis.fetch;
    try {
      for (const payload of [{ errors: [{ message: 'unavailable' }] }, { data: {} }, { data: { account: { zkappState: null } } }]) {
        globalThis.fetch = (async (_url, init) => { expect(init?.cache).toBe('no-store'); return new Response(JSON.stringify(payload)); }) as typeof fetch;
        await expect(nodeAccountReader('http://node')('vault', '1')).rejects.toThrow();
      }
    } finally { globalThis.fetch = original; }
  });
});
