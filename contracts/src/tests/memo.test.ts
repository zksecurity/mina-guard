import { Field, Poseidon } from 'o1js';
import { memoToField, decodeTxMemo } from '../memo.js';
import { describe, expect, it } from 'bun:test';
import { sha256 } from '@noble/hashes/sha256';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = '';
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  return '1'.repeat(bytes.findIndex((byte) => byte !== 0) < 0
    ? bytes.length : bytes.findIndex((byte) => byte !== 0)) + result;
}

function encodedMemo(content = 'rent payment', tag = 1): string {
  const payload = new Uint8Array(39);
  const bytes = new TextEncoder().encode(content);
  payload[0] = 0x14;
  payload[1] = tag;
  payload[2] = bytes.length;
  payload.set(bytes, 3);
  payload.set(sha256(sha256(payload.subarray(0, 35))).subarray(0, 4), 35);
  return base58Encode(payload);
}

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

  it('rejects a flipped checksum byte', () => {
    const bytes = new Uint8Array(39);
    bytes[0] = 0x14;
    bytes[1] = 1;
    bytes.set(sha256(sha256(bytes.subarray(0, 35))).subarray(0, 4), 35);
    bytes[38] ^= 1;
    expect(() => decodeTxMemo(base58Encode(bytes))).toThrow('invalid checksum');
  });

  it('rejects another memo tag even with a valid checksum', () => {
    expect(() => decodeTxMemo(encodedMemo('rent payment', 2))).toThrow('invalid memo tag');
  });

  it('rejects a truncated payload and a length beyond the content capacity', () => {
    expect(() => decodeTxMemo(base58Encode(new Uint8Array([0x14, 1, 0]))))
      .toThrow('expected 39 bytes');
    const bytes = new Uint8Array(39);
    bytes[0] = 0x14;
    bytes[1] = 1;
    bytes[2] = 33;
    bytes.set(sha256(sha256(bytes.subarray(0, 35))).subarray(0, 4), 35);
    expect(() => decodeTxMemo(base58Encode(bytes))).toThrow('invalid content length');
  });
});
