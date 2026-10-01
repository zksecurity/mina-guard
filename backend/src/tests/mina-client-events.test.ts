import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Field, PrivateKey, PublicKey } from 'o1js';
import { MinaGuard } from 'contracts';
import {
  decodeContractEvents,
  decodeMinaGuardEvent,
  fetchArchiveEventBlocks,
  isFromAppliedTransaction,
  type ArchiveEventBlock,
} from '../mina-client.js';

type Provable = { toFields(value: unknown): Field[] };
const EVENTS = new MinaGuard(PublicKey.empty()).events as unknown as Record<string, Provable>;
const NAMES = Object.keys(EVENTS).sort();

/** Raw fields exactly as a genuine emitEvent produces them: type index, then the value. */
function encode(type: string, value: Record<string, unknown>): string[] {
  return [String(NAMES.indexOf(type)), ...EVENTS[type].toFields(value).map(String)];
}

const approver = PrivateKey.random().toPublicKey();
function approval(proposalHash: bigint): string[] {
  return encode('approval', {
    proposalHash: Field(proposalHash),
    approver,
    approvalCount: Field(3),
    approvalRoot: Field(7),
    voteNullifierRoot: Field(8),
  });
}

type RawEvent = { data: unknown; status?: string; hash?: string; kind?: string | null };

/** A block as the archive API returns it; events default to proof-authorized. */
function block(height: number, events: RawEvent[]): ArchiveEventBlock {
  return {
    blockInfo: { height, stateHash: `hash-${height}`, parentHash: `hash-${height - 1}` },
    eventData: events.map((e, i) => ({
      data: e.data,
      transactionInfo: {
        hash: e.hash ?? `tx-${height}-${i}`,
        memo: '',
        status: e.status ?? 'applied',
        ...(e.kind === null ? {} : { authorizationKind: e.kind ?? 'Proof' }),
      },
    })),
  };
}

afterEach(() => {
  spyOn(console, 'warn').mockRestore();
  spyOn(globalThis, 'fetch').mockRestore();
});

describe('failed-transaction events', () => {
  test('isFromAppliedTransaction drops only an explicit failure', () => {
    expect(isFromAppliedTransaction('applied')).toBe(true);
    expect(isFromAppliedTransaction('failed')).toBe(false);
    expect(isFromAppliedTransaction('FAILED')).toBe(false);
    expect(isFromAppliedTransaction('')).toBe(true); // local chains
    expect(isFromAppliedTransaction(undefined)).toBe(true);
  });

  test('decodeContractEvents never returns events of a failed transaction', () => {
    const events = decodeContractEvents('vault', [block(7, [
      { data: approval(11n), status: 'applied', hash: 'tx-11' },
      { data: approval(12n), status: 'failed', hash: 'tx-12' },
      { data: approval(13n), status: '', hash: 'tx-13' },
    ])]);
    expect(events.map((e) => e.event.proposalHash)).toEqual(['11', '13']);
    expect(events.map((e) => e.txHash)).toEqual(['tx-11', 'tx-13']);
  });
});

describe('event decoding', () => {
  test('decodes a genuine event into the typed shape the indexer stores', () => {
    expect(decodeMinaGuardEvent(approval(42n))).toEqual({
      type: 'approval',
      event: {
        proposalHash: '42',
        approver: approver.toBase58(),
        approvalCount: '3',
        approvalRoot: '7',
        voteNullifierRoot: '8',
      },
    });
  });

  test('keeps genuine events that carry an empty public key, like a root vault setup', () => {
    const setup = encode('setup', {
      ownersCommitment: Field(5), threshold: Field(1), numOwners: Field(1), parent: PublicKey.empty(),
    });
    expect(decodeMinaGuardEvent(setup)).toEqual({
      type: 'setup',
      event: { ownersCommitment: '5', threshold: '1', numOwners: '1', parent: PublicKey.empty().toBase58() },
    });
  });

  test('rejects events that o1js would throw on or decode into garbage', () => {
    const good = approval(1n);
    const owner = encode('setupOwner', { owner: approver, index: Field(0) });
    const cases: Array<[string, unknown]> = [
      ['no data', []],
      ['not a list', 'nope'],
      ['unknown type index', ['99', ...good.slice(1)]],
      ['too few fields', good.slice(0, -1)],
      ['too many fields', [...good, '0']],
      ['non-numeric field', [good[0], 'abc', ...good.slice(2)]],
      ['field above the modulus', [good[0], (Field.ORDER + 1n).toString(), ...good.slice(2)]],
      // setupOwner.owner is [x, isOdd]; isOdd = 2 is not a boolean.
      ['value fails its type check', [owner[0], owner[1], '2', owner[3]]],
    ];
    for (const [name, data] of cases) {
      const result = decodeMinaGuardEvent(data);
      expect({ name, rejected: 'error' in result }).toEqual({ name, rejected: true });
    }
  });

  test('passes an undecodable proof-authorized event on as malformed, keeping its neighbours', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const events = decodeContractEvents('vault', [
      block(5, [{ data: approval(1n) }, { data: ['99', '0'] }]),
      block(6, [{ data: approval(2n).slice(0, 3) }, { data: approval(3n) }]),
    ]);
    expect(events.map((e) => [e.blockHeight, e.type])).toEqual([
      [5, 'approval'], [5, 'malformed'], [6, 'malformed'], [6, 'approval'],
    ]);
    expect(events[1]).toMatchObject({ event: { data: ['99', '0'] }, decodeError: 'unknown event type index 99' });
    expect(events[3].event.proposalHash).toBe('3');
    expect(events[3].blockHash).toBe('hash-6');
    expect(events[3].parentHash).toBe('hash-5');
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  test('drops a malformed event that is not proof-authorized, like any forged event', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const events = decodeContractEvents('vault', [block(5, [{ data: ['99', '0'], kind: 'None_given' }])]);
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('event authorization', () => {
  test('keeps only events from proof-authorized account updates', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const events = decodeContractEvents('vault', [block(5, [
      { data: approval(1n), kind: 'Proof' },
      { data: approval(2n), kind: 'None_given' },
      { data: approval(3n), kind: 'Signature' },
    ])]);
    expect(events.map((e) => e.event.proposalHash)).toEqual(['1']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('None_given-authorized');
  });

  test('skips the signed deploy event without a warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const deployed = encode('deployed', { guardAddress: approver });
    const events = decodeContractEvents('vault', [block(5, [{ data: deployed, kind: 'Signature' }])]);
    expect(events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  test('fails closed when the archive omits the authorization kind', () => {
    expect(() => decodeContractEvents('vault', [block(5, [{ data: approval(1n), kind: null }])]))
      .toThrow('no authorization kind');
  });
});

describe('archive event query', () => {
  const endpoints = { primary: 'http://archive', fallback: 'http://archive-fallback' };

  test('asks the archive for each event\'s authorization kind', async () => {
    const bodies: Array<{ query: string; variables: { input: Record<string, unknown> } }> = [];
    spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { events: [block(5, [{ data: approval(1n) }])] } });
    }) as typeof fetch);

    const blocks = await fetchArchiveEventBlocks(endpoints, 'B62qvault', 4);

    expect(blocks).toHaveLength(1);
    expect(bodies[0].query).toContain('authorizationKind');
    expect(bodies[0].variables.input).toMatchObject({ address: 'B62qvault', from: 4 });
    expect(typeof bodies[0].variables.input.tokenId).toBe('string');
  });

  test('omits `from` for a scan from genesis and falls back to the second endpoint', async () => {
    const urls: string[] = [];
    spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url) === endpoints.primary) return new Response('down', { status: 502 });
      expect(JSON.parse(String(init?.body)).variables.input).not.toHaveProperty('from');
      return Response.json({ data: { events: [] } });
    }) as typeof fetch);

    expect(await fetchArchiveEventBlocks(endpoints, 'B62qvault', 0)).toEqual([]);
    expect(urls).toEqual([endpoints.primary, endpoints.fallback]);
  });

  test('explains an archive that does not expose authorizationKind', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({
      errors: [{ message: 'Cannot query field "authorizationKind" on type "TransactionInfo".' }],
    })) as typeof fetch);

    await expect(fetchArchiveEventBlocks({ primary: 'http://old-archive', fallback: null }, 'B62qvault', 0))
      .rejects.toThrow('v0.0.8 or later');
  });
});
