import { afterEach, expect, test } from 'bun:test';
import { fetchContractOwnerMap, fetchContracts } from '../lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('uses active owners bundled with the contract list without per-vault requests', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json([
      { address: 'vault-a', activeOwnerAddresses: ['owner-a'] },
      { address: 'vault-b', activeOwnerAddresses: [] },
    ]);
  }) as typeof fetch;

  const contracts = await fetchContracts();
  const owners = await fetchContractOwnerMap(contracts);
  expect(owners.get('vault-a')).toEqual(['owner-a']);
  expect(owners.get('vault-b')).toEqual([]);
  expect(calls).toHaveLength(1);
});

test('falls back only for contracts served by an older backend', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/contracts')) {
      return Response.json([
        { address: 'vault-a', activeOwnerAddresses: ['owner-a'] },
        { address: 'vault-b' },
      ]);
    }
    if (url.endsWith('/api/contracts/vault-b/owners')) {
      return Response.json([
        { address: 'owner-b', active: true },
        { address: 'removed-owner', active: false },
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const owners = await fetchContractOwnerMap(await fetchContracts());
  expect(owners.get('vault-a')).toEqual(['owner-a']);
  expect(owners.get('vault-b')).toEqual(['owner-b']);
  expect(calls).toHaveLength(2);
});
