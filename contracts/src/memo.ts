import { Field, Poseidon } from 'o1js';
import { MEMO_HASH_PREFIX } from './proposal-signing.js';
import { sha256 } from '@noble/hashes/sha256';

export function memoToField(memo: string): Field {
  const bytes = new TextEncoder().encode(memo);
  return Poseidon.hashWithPrefix(MEMO_HASH_PREFIX, [Field(bytes.length), ...Array.from(bytes, (b) => Field(b))]);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(input: string): Uint8Array {
  const base = BASE58_ALPHABET.length;
  const bytes: number[] = [0];
  for (const char of input) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * base;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// Mina memo base58check layout: version (1B) + tag (1B) + length (1B) + content (32B) + checksum (4B).
// Version 0x14 and tag 0x01 identify a user memo.
export function decodeTxMemo(base58Memo: string): string {
  const raw = base58Decode(base58Memo);
  if (raw.length !== 39) {
    throw new Error(`decodeTxMemo: expected 39 bytes, got ${raw.length}`);
  }
  if (raw[0] !== 0x14) {
    throw new Error('decodeTxMemo: invalid memo version');
  }
  const data = raw.subarray(0, 35);
  const expectedChecksum = sha256(sha256(data)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (raw[35 + i] !== expectedChecksum[i]) {
      throw new Error('decodeTxMemo: invalid checksum');
    }
  }
  const payload = raw.subarray(1, 35);
  if (payload[0] !== 0x01) throw new Error('decodeTxMemo: invalid memo tag');
  const contentLength = payload[1];
  if (contentLength > 32) {
    throw new Error(`decodeTxMemo: invalid content length ${contentLength}`);
  }
  if (payload.subarray(2 + contentLength).some((byte) => byte !== 0)) {
    throw new Error('decodeTxMemo: nonzero bytes after declared content length');
  }
  const contentBytes = payload.subarray(2, 2 + contentLength);
  return new TextDecoder().decode(contentBytes);
}
