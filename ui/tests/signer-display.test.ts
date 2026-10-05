import { afterEach, describe, expect, test } from 'bun:test';
import { toProposal } from '../lib/api';
import { memoBadge } from '../lib/memo-check';
import { requireTxType } from '../lib/types';
import { fetchBalance } from '../components/TestnetFundButton';

const A = 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY';
const B = 'B62qoG5Yk4iVxpyczUrBNpwtx2xunhL48dydN53A2VjoRwF8NUjtL3';

describe('proposal display values come from the signed receivers', () => {
  test('served total, count and target are ignored', () => {
    const proposal = toProposal({
      proposalHash: '1',
      txType: 'transfer',
      receivers: [{ index: 0, address: A, amount: '1000000000' }, { index: 1, address: B, amount: '500000000' }],
      totalAmount: '1',
      recipientCount: 9,
      toAddress: B,
    });
    expect(proposal.totalAmount).toBe('1500000000');
    expect(proposal.recipientCount).toBe(2);
    expect(proposal.toAddress).toBe(A);
  });

  test('a governance target is receivers[0], and none means no target', () => {
    const add = toProposal({ proposalHash: '2', txType: 'addOwner', receivers: [{ address: A, amount: '0' }], toAddress: B });
    expect(add.toAddress).toBe(A);
    const undelegate = toProposal({ proposalHash: '3', txType: 'setDelegate', receivers: [], toAddress: B });
    expect(undelegate.toAddress).toBeNull();
    expect(undelegate.totalAmount).toBeNull();
  });
});

describe('memo badge', () => {
  const pending = { memoHash: '7', status: 'pending' as const, memoExecutionMatch: null };
  const executed = { memoHash: '7', status: 'executed' as const, memoExecutionMatch: true };

  test('shows nothing until the browser has checked the memo itself', () => {
    expect(memoBadge(pending, null)).toBeNull();
    expect(memoBadge(executed, null)).toBeNull();
  });

  test('follows the local check, not a served flag', () => {
    expect(memoBadge(pending, false)).toBe('proposalMismatch');
    expect(memoBadge(pending, true)).toBeNull();
    expect(memoBadge(executed, true)).toBe('match');
    expect(memoBadge(executed, false)).toBe('mismatch');
    expect(memoBadge({ ...executed, memoExecutionMatch: false }, true)).toBe('mismatch');
    expect(memoBadge({ ...pending, memoHash: null }, false)).toBeNull();
  });
});

test('signing refuses an unknown transaction type instead of treating it as a transfer', () => {
  expect(requireTxType('transfer')).toBe('transfer');
  expect(requireTxType('3')).toBe('changeThreshold');
  for (const bad of [null, '', 'Transfer', ' transfer', '10', 'transfer\u001b[2J']) {
    expect(() => requireTxType(bad)).toThrow('Unsupported transaction type');
  }
});

describe('testnet fund button balance', () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });

  test('sends the address as a GraphQL variable, not inside the query text', async () => {
    globalThis.window = {
      __minaGuardConfig: { networkId: 'testnet', minaEndpoint: 'https://node.example/graphql' },
    } as unknown as Window & typeof globalThis;
    const sneaky = `${A}") { nonce } x: account(publicKey: "${B}`;
    let body: { query: string; variables: Record<string, string> } | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ data: { account: { balance: { total: '42' } } } });
    }) as unknown as typeof fetch;

    expect(await fetchBalance(sneaky)).toBe(42);
    expect(body?.variables).toEqual({ publicKey: sneaky });
    expect(body?.query).not.toContain(A);
  });
});
