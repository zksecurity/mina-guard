import { Field, Poseidon } from 'o1js';

export function memoToField(memo: string): Field {
  if (memo.length === 0) return Field(0);
  const bytes = new TextEncoder().encode(memo);
  return Poseidon.hash(Array.from(bytes, (b) => Field(b)));
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

// Mina memo base58check layout: version (1B) + tag (1B) + length (1B) + content (32B) + checksum (4B)
// Tag 0x01 = user memo. See MinaProtocol/mina signed_command_memo.ml L49-61.
export function decodeTxMemo(base58Memo: string): string {
  const raw = base58Decode(base58Memo);
  const payload = raw.slice(1, raw.length - 4); // strip version byte + 4-byte base58check checksum
  if (payload.length !== 34) {
    throw new Error(`decodeTxMemo: expected 34-byte payload, got ${payload.length}`);
  }
  const contentLength = payload[1];
  if (contentLength > 32) {
    throw new Error(`decodeTxMemo: invalid content length ${contentLength}`);
  }
  const contentBytes = payload.slice(2, 2 + contentLength);
  return new TextDecoder().decode(contentBytes);
}
