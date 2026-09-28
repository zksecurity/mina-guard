import { afterEach, describe, expect, it } from 'bun:test';
import { fetchAllEvents } from '../../ui/lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('incremental event transport', () => {
  it('keeps fromBlock and advances the offset across pages', async () => {
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
    expect(urls[0].searchParams.get('offset')).toBe('0');
    expect(urls[1].searchParams.get('offset')).toBe('500');
    expect(urls[1].searchParams.has('cursor')).toBe(false);
    expect(events[0].blockHeight).toBe(21);
  });

  it('fails closed at the offset cap without requesting a clamped page', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++;
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      expect(offset).toBeLessThanOrEqual(50_000);
      return Response.json(Array.from({ length: 500 }, () => ({
        eventType: 'approval', payload: {}, blockHeight: 1,
      })));
    }) as typeof fetch;
    await expect(fetchAllEvents('vault')).rejects.toThrow('pagination limit');
    expect(calls).toBe(101);
  });

  it('rejects a failed later page instead of returning a partial history', async () => {
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1
      ? Response.json(Array.from({ length: 500 }, (_, i) => ({ id: 1000 - i, eventType: 'approval', payload: {}, blockHeight: 10 })))
      : new Response('unavailable', { status: 503 })) as typeof fetch;
    await expect(fetchAllEvents('vault')).rejects.toThrow('503');
  });

  it('rejects malformed page data', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'bad page' })) as typeof fetch;
    await expect(fetchAllEvents('vault')).rejects.toThrow('Invalid vault events response');
  });
});
