/** Public transaction data only. This check never edits or signs the transaction. */
export type PreflightResult = { status: 'current' | 'stale' | 'unavailable'; message?: string };
/** The node's view of one account: its app state, `'bare'` for an account that
 * exists without zkApp state (a plain payment created it), or `null` for none. */
export type AccountState = string[] | 'bare' | null;
export type ReadAccount = (publicKey: string, tokenId: string) => Promise<AccountState>;

const decimal = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);

/** Check all explicit app-state preconditions, not just hard-coded root slots.
 * Repeated updates are evaluated in transaction order, including in-tx writes.
 * An absent account can be initialized by an unconstrained deployment update;
 * otherwise a missing account requires an explicit isNew precondition.
 * A bare account reads as all-zero state, which is what a deployment into it
 * initializes; an isNew precondition on it is stale, since the account exists.
 */
export async function checkTransactionState(txJson: string, read: ReadAccount): Promise<PreflightResult> {
  try {
    const tx = JSON.parse(txJson);
    if (!Array.isArray(tx?.accountUpdates)) throw new Error('Invalid transaction');
    const states = new Map<string, AccountState>();
    for (const update of tx.accountUpdates) {
      const body = update?.body;
      const expected = body?.preconditions?.account?.state;
      const written = body?.update?.appState;
      if (typeof body?.publicKey !== 'string' || typeof body?.tokenId !== 'string' ||
          !Array.isArray(expected) || !Array.isArray(written) || expected.length !== written.length ||
          !expected.every((x: unknown) => x === null || decimal(x)) ||
          !written.every((x: unknown) => x === null || decimal(x))) throw new Error('Invalid account update');
      if (expected.every((x: unknown) => x === null) && written.every((x: unknown) => x === null)) continue;
      const key = JSON.stringify([body.publicKey, body.tokenId]);
      if (!states.has(key)) states.set(key, await read(body.publicKey, body.tokenId));
      let actual = states.get(key)!;
      if (actual === null || actual === 'bare') {
        const isNew = body.preconditions.account.isNew === true;
        if (actual === null ? !isNew && expected.some((value: unknown) => value !== null) : isNew) return { status: 'stale' };
        actual = Array(expected.length).fill('0');
      }
      if (actual.length !== expected.length || !actual.every(decimal)) throw new Error('Incomplete account state');
      if (expected.some((value: string | null, i: number) => value !== null && BigInt(value) !== BigInt(actual![i]))) {
        return { status: 'stale' };
      }
      states.set(key, actual.map((value, i) => written[i] ?? value));
    }
    return { status: 'current' };
  } catch {
    return { status: 'unavailable', message: 'Could not read complete transaction and account state.' };
  }
}

/** Fresh node query: no indexer or o1js account cache. */
export function nodeAccountReader(endpoint: string): ReadAccount {
  return async (publicKey, tokenId) => {
    const response = await fetch(endpoint, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($publicKey: PublicKey!, $token: TokenId!) { account(publicKey: $publicKey, token: $token) { zkappState } }',
        variables: { publicKey, token: tokenId },
      }),
    });
    if (!response.ok) throw new Error('Node unavailable');
    const json = await response.json();
    if (json.errors?.length || !json.data || !('account' in json.data)) throw new Error('Incomplete node response');
    const account = json.data.account;
    if (account === null) return null;
    // The field must be answered: `null` is a bare account, an array its state.
    if (typeof account !== 'object' || !('zkappState' in account)) throw new Error('Missing app state');
    const state = account.zkappState;
    if (state === null) return 'bare';
    if (!Array.isArray(state)) throw new Error('Missing app state');
    return state;
  };
}
