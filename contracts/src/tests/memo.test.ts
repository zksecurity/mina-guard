import { Field } from 'o1js';
import { memoToField, decodeTxMemo } from '../memo.js';
import { describe, expect, it } from 'bun:test';

describe('memoToField', () => {
  it('returns Field(0) for the empty string', () => {
    expect(memoToField('').toString()).toEqual(Field(0).toString());
  });

  it('produces distinct commitments for distinct memos', () => {
    expect(memoToField('hello').toString()).not.toEqual(
      memoToField('world').toString()
    );
  });

  it('is deterministic', () => {
    expect(memoToField('rent payment').toString()).toEqual(
      memoToField('rent payment').toString()
    );
  });
});

describe('decodeTxMemo', () => {
  it('decodes a base58check-encoded memo to plaintext', () => {
    expect(decodeTxMemo('E4YmEEfk9NFJZBjzsNatCdzLGVbYK6xWZa9oBgLkwNoLqQh34cjPv')).toBe('rent payment');
  });

  it('decodes the empty memo to an empty string', () => {
    expect(decodeTxMemo('E4YM2vTHhWEg66xpj52JErHUBU4pZ1yageL4TVDDpTTSsv8mK6YaH')).toBe('');
  });

  it('round-trips: memoToField(decodeTxMemo(encoded)) equals memoToField(plaintext)', () => {
    const plaintext = 'rent payment';
    const encoded = 'E4YmEEfk9NFJZBjzsNatCdzLGVbYK6xWZa9oBgLkwNoLqQh34cjPv';
    expect(memoToField(decodeTxMemo(encoded)).toString()).toEqual(
      memoToField(plaintext).toString()
    );
  });
});
