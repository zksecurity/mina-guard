import { describe, expect, test } from 'bun:test';
import { describeThrown } from '../indexer.js';

// describeThrown feeds tick()'s catch block, which runs fire-and-forget under
// setInterval. If stringifying the thrown value throws, that rejection is
// unhandled and server.ts turns it into shutdown(…, 1) — i.e. the whole
// backend exits. So the one property that actually matters here is: it must
// NEVER throw, whatever it's handed. These are the inputs that made the old
// JSON.stringify implementation throw.
describe('describeThrown', () => {
  test('renders a bigint-bearing object (o1js-shaped) instead of throwing', () => {
    // JSON.stringify throws "cannot serialize BigInt" on this; o1js values
    // routinely carry bigints, so this is the real-world crash case.
    const thrown = { code: 'FieldOverflow', amount: 42n, sender: { balance: 1000n } };
    const out = describeThrown(thrown);
    expect(typeof out).toBe('string');
    expect(out).toContain('FieldOverflow');
    expect(out).toContain('42n');
  });

  test('renders a circular structure instead of throwing', () => {
    // JSON.stringify throws "cannot serialize cyclic structures" on this.
    const circular: Record<string, unknown> = { name: 'reorg' };
    circular.self = circular;
    const out = describeThrown(circular);
    expect(typeof out).toBe('string');
    expect(out).toContain('reorg');
    expect(out).toContain('Circular');
  });

  test('returns a plain string verbatim (no inspect quoting)', () => {
    expect(describeThrown('boom')).toBe('boom');
  });

  test('falls back (not throws) when inspect itself throws via a custom hook', () => {
    // A throwing toString/getter does NOT faze inspect — it prints [Function]/
    // [Getter] without invoking them. The one thing that makes inspect throw is
    // a throwing custom-inspect hook; that is what must hit the try/catch and
    // land on the Object.prototype.toString.call fallback.
    const hostile = {
      [Symbol.for('nodejs.util.inspect.custom')]() {
        throw new Error('nope');
      },
    };
    expect(() => describeThrown(hostile)).not.toThrow();
    expect(describeThrown(hostile)).toBe('[object Object]');
  });
});
