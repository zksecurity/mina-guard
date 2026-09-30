import { describe, expect, test } from 'bun:test';
import { Field, PrivateKey, PublicKey, UInt32 } from 'o1js';
import { MinaGuard } from 'contracts';
import {
  decodeContractEvents,
  decodeMinaGuardEvent,
  isFromAppliedTransaction,
  type RawEventBlock,
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

function block(height: number, events: Array<{ data: unknown; status?: string; hash?: string }>): RawEventBlock {
  return {
    blockHeight: UInt32.from(height),
    blockHash: `hash-${height}`,
    parentBlockHash: `hash-${height - 1}`,
    globalSlot: UInt32.from(height),
    chainStatus: 'canonical',
    events: events.map((e, i) => ({
      data: e.data,
      transactionInfo: { hash: e.hash ?? `tx-${height}-${i}`, memo: '', status: e.status ?? 'applied' },
    })),
  } as unknown as RawEventBlock;
}

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

  test('a malformed event is skipped without dropping the valid events around it', () => {
    const events = decodeContractEvents('vault', [
      block(5, [{ data: approval(1n) }, { data: ['99', '0'] }]),
      block(6, [{ data: approval(2n).slice(0, 3) }, { data: approval(3n) }]),
    ]);
    expect(events.map((e) => [e.blockHeight, e.event.proposalHash])).toEqual([[5, '1'], [6, '3']]);
    expect(events[1].blockHash).toBe('hash-6');
    expect(events[1].parentHash).toBe('hash-5');
  });
});
