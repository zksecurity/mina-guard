import { afterEach, describe, expect, it } from 'bun:test';
import { fetchAllEvents } from '../../ui/lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('incremental event transport', () => {
  it('keeps fromBlock and advances the ID cursor across pages', async () => {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      const data = urls.length === 1
        ? Array.from({ length: 500 }, (_, i) => ({ id: 1000 - i, eventType: 'approval', payload: '{}', blockHeight: 30 - Math.floor(i / 100) }))
        : [{ id: 500, eventType: 'proposal', payload: '{}', blockHeight: 21 }];
      return Response.json(data);
    }) as typeof fetch;
    const events = await fetchAllEvents('vault', 21);
    expect(events).toHaveLength(501);
    expect(urls[0].searchParams.get('fromBlock')).toBe('21');
    expect(urls[1].searchParams.get('fromBlock')).toBe('21');
    expect(urls[0].searchParams.get('cursor')).toBe('true');
    expect(urls[1].searchParams.get('beforeId')).toBe('501');
    expect(urls[1].searchParams.has('offset')).toBe(false);
    expect(events[0].blockHeight).toBe(21);
  });

  it('finishes an initial sync beyond the legacy 50,000-row offset cap', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++;
      const query = new URL(String(input)).searchParams;
      expect(query.has('offset')).toBe(false);
      const high = Number(query.get('beforeId') ?? 50502) - 1;
      const count = Math.min(500, high);
      return Response.json(Array.from({ length: count }, (_, i) => ({
        id: high - i, eventType: 'approval', payload: { sequence: high - i }, blockHeight: 1,
      })));
    }) as typeof fetch;
    const events = await fetchAllEvents('vault');
    expect(events).toHaveLength(50501);
    expect(calls).toBe(102);
    expect(new Set(events.map(e => (e.payload as { sequence: number }).sequence)).size).toBe(50501);
  });

  it('rejects a failed later page instead of returning a partial history', async () => {
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1
      ? Response.json(Array.from({ length: 500 }, (_, i) => ({ id: 1000 - i, eventType: 'approval', payload: {}, blockHeight: 10 })))
      : new Response('unavailable', { status: 503 })) as typeof fetch;
    await expect(fetchAllEvents('vault')).rejects.toThrow('503');
  });

  it('rejects a repeated page instead of looping on an old backend', async () => {
    globalThis.fetch = (async () => Response.json(Array.from({ length: 500 }, (_, i) => ({
      id: 1000 - i, eventType: 'approval', payload: {}, blockHeight: 10,
    })))) as typeof fetch;
    await expect(fetchAllEvents('vault')).rejects.toThrow('Invalid event cursor');
  });

  it('rejects malformed page data', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'bad page' })) as typeof fetch;
    await expect(fetchAllEvents('vault')).rejects.toThrow('Invalid vault events response');
  });
});
