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
  expect(calls[0]).toEndWith('/api/contracts?limit=200');
});

test('reads the vault list page by page, each after the last row of the one before', async () => {
  const calls: string[] = [];
  // Newest first: vault-449 down to vault-0, all discovered at one instant so
  // the id breaks the tie.
  const at = '2026-07-01T12:00:00.000Z';
  const vault = (n: number) => ({ id: n, discoveredAt: at, address: `vault-${n}`, activeOwnerAddresses: [] });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const limit = Number(url.searchParams.get('limit'));
    const beforeId = url.searchParams.has('beforeId') ? Number(url.searchParams.get('beforeId')) : 450;
    expect(url.searchParams.has('beforeId')).toBe(url.searchParams.get('beforeDiscoveredAt') === at);
    const ids = Array.from({ length: beforeId }, (_, i) => beforeId - 1 - i).slice(0, limit);
    return Response.json(ids.map(vault));
  }) as typeof fetch;

  const contracts = await fetchContracts();
  expect(contracts).toHaveLength(450);
  expect(contracts[0].address).toBe('vault-449');
  expect(contracts[449].address).toBe('vault-0');
  const cursor = (id: number) => `&beforeDiscoveredAt=${encodeURIComponent(at)}&beforeId=${id}`;
  expect(calls).toEqual(['?limit=200', `?limit=200${cursor(250)}`, `?limit=200${cursor(50)}`]);
});

test('stops when a full page carries no cursor', async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    calls++;
    return Response.json(Array.from({ length: 200 }, (_, i) => ({ address: `vault-${calls}-${i}` })));
  }) as typeof fetch;

  expect(await fetchContracts()).toHaveLength(200);
  expect(calls).toBe(1);
});

test('stops after one read when an older backend returns the whole list unpaged', async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    calls++;
    return Response.json(Array.from({ length: 250 }, (_, i) => ({ address: `vault-${i}` })));
  }) as typeof fetch;

  expect(await fetchContracts()).toHaveLength(250);
  expect(calls).toBe(1);
});

test('lists each vault once if a page repeats rows of the one before', async () => {
  const vault = (n: number) => ({ id: 1000 - n, discoveredAt: '2026-07-01T12:00:00.000Z', address: `vault-${n}`, activeOwnerAddresses: [] });
  let page = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    page++;
    // A backend that pages by offset repeats the old row 199 when a vault is
    // discovered between reads.
    if (page === 1) return Response.json(Array.from({ length: 200 }, (_, i) => vault(i)));
    return Response.json([vault(199), ...Array.from({ length: 50 }, (_, i) => vault(200 + i))]);
  }) as typeof fetch;

  const contracts = await fetchContracts();
  expect(contracts).toHaveLength(250);
  expect(new Set(contracts.map((contract) => contract.address)).size).toBe(250);
});

test('stops when a full page adds no new vault', async () => {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    calls++;
    return Response.json(Array.from({ length: 200 }, (_, i) => ({ id: 200 - i, discoveredAt: '2026-07-01T12:00:00.000Z', address: `vault-${i}` })));
  }) as typeof fetch;

  expect(await fetchContracts()).toHaveLength(200);
  expect(calls).toBe(2);
});

test('gives an empty list when a later page fails, as for a failed first page', async () => {
  let page = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    page++;
    if (page === 1) return Response.json(Array.from({ length: 200 }, (_, i) => ({ id: 200 - i, discoveredAt: '2026-07-01T12:00:00.000Z', address: `vault-${i}` })));
    return new Response('down', { status: 503 });
  }) as typeof fetch;

  expect(await fetchContracts()).toEqual([]);
  expect(page).toBe(2);
});

test('falls back only for contracts served by an older backend', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/contracts?')) {
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
