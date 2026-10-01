import { afterEach, expect, test } from 'bun:test';
import { countNewRecipientSlots } from '../lib/recipient-account-fee';
import { EMPTY_PUBKEY_B58 } from '../lib/types';

const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.window = previousWindow;
  globalThis.fetch = previousFetch;
});

test('counts new canonical recipient slots using the runtime Mina endpoint', async () => {
  globalThis.window = {
    __minaGuardConfig: { networkId: 'testnet', minaEndpoint: 'https://node.example/graphql' },
  } as unknown as Window & typeof globalThis;
  const checked: string[] = [];
  globalThis.fetch = (async (url, init) => {
    expect(url).toBe('https://node.example/graphql');
    const address = JSON.parse(String(init?.body)).variables.publicKey;
    checked.push(address);
    return Response.json({ data: { account: address === 'existing' ? { publicKey: address } : null } });
  }) as typeof fetch;

  const receivers = [
    { address: 'new' }, { address: 'existing' }, { address: EMPTY_PUBKEY_B58 },
    ...Array.from({ length: 7 }, (_, i) => ({ address: `extra-${i}` })),
  ];
  expect(await countNewRecipientSlots(receivers)).toBe(7);
  expect(checked).toEqual(['new', 'existing', 'extra-0', 'extra-1', 'extra-2', 'extra-3', 'extra-4', 'extra-5']);
});

test('fails closed when recipient status cannot be checked', async () => {
  globalThis.window = {
    __minaGuardConfig: { networkId: 'testnet', minaEndpoint: 'https://node.example/graphql' },
  } as unknown as Window & typeof globalThis;
  globalThis.fetch = (async () => Response.json({ errors: [{ message: 'node unavailable' }] })) as typeof fetch;
  await expect(countNewRecipientSlots([{ address: 'new' }])).rejects.toThrow('Could not check recipient accounts');
});
