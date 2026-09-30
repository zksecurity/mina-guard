import { Field, Poseidon } from 'o1js';
import { memoToField, decodeTxMemo } from '../memo.js';
import { describe, expect, it } from 'bun:test';

describe('memoToField', () => {
  it('uniformly commits the empty string under the memo domain', () => {
    expect(memoToField('').toString()).not.toEqual(Field(0).toString());
    expect(memoToField('').toString()).toEqual(Poseidon.hashWithPrefix('mina-guard-memo', [Field(0)]).toString());
  });

  it('produces distinct commitments for distinct memos', () => {
    expect(memoToField('hello').toString()).not.toEqual(
      memoToField('world').toString()
    );
  });

  it('commits the UTF-8 byte length and distinguishes trailing zero bytes', () => {
    const memo = 'é🔐';
    const bytes = new TextEncoder().encode(memo);
    expect(memoToField(memo).toString()).toBe(Poseidon.hashWithPrefix('mina-guard-memo', [Field(bytes.length), ...Array.from(bytes, b => Field(b))]).toString());
    for (const text of ['', 'a', 'ab']) {
      expect(memoToField(text).toString()).not.toBe(memoToField(text + '\0').toString());
    }
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
