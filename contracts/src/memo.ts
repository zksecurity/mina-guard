import { Field, Poseidon } from 'o1js';

/**
 * Encodes a memo string as the Field commitment stored in
 * `TransactionProposal.memoHash`.
 *
 * Shared between the UI (when building a proposal to sign) and the backend
 * (when verifying a submitted plaintext memo against its claimed memoHash),
 * so both sides MUST derive the commitment the same way.
 *
 * Empty string → `Field(0)` (the "no memo" convention).
 */
export function memoToField(memo: string): Field {
  if (memo.length === 0) return Field(0);
  const bytes = new TextEncoder().encode(memo);
  return Poseidon.hash(Array.from(bytes, (b) => Field(b)));
}

// ---------------------------------------------------------------------------
// Base58check → plaintext memo decoder
//
// Mina archive nodes return the outer transaction memo as a base58check-
// encoded string. The wire format is:
//   base58check( versionByte=0x14 | 34-byte-payload )
// where the 34-byte payload is:
//   [ 0x01, length, ...utf8Content, ...zeroPadding ]
//
// This decoder is self-contained (no o1js deep imports, no external deps)
// because the o1js package doesn't re-export its internal Memo module.
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes a base58-encoded string into raw bytes. */
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
  // Preserve leading zeros (base58 '1' characters)
  for (const char of input) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Decodes a Mina base58check-encoded transaction memo to plaintext.
 *
 * Wire format: `base58check(0x14 | 34-byte-payload)`.
 * Payload:     `[0x01, length, ...utf8Content, ...zeroPadding]`.
 *
 * Returns the UTF-8 plaintext. Throws on malformed input.
 */
export function decodeTxMemo(base58Memo: string): string {
  const raw = base58Decode(base58Memo);
  // Strip version byte (first byte = 0x14) and checksum (last 4 bytes).
  const payload = raw.slice(1, raw.length - 4);
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
