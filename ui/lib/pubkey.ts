/**
 * Base58 helpers for Mina addresses that need no o1js, so React components can
 * compare keys without loading the prover bundle.
 */

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

// A decoded address is 40 bytes: version prefix + x-coordinate (35), parity (1), checksum (4).
const ADDRESS_BYTES = 40;
const PARITY_INDEX = 35;

/**
 * True when two addresses belong to the same key holder: identical, or one the
 * negation of the other (same x-coordinate, flipped parity). The contract
 * treats those as one owner. False for anything that does not decode.
 */
export function sameKeyHolder(a: string, b: string): boolean {
  try {
    const x = base58Decode(a);
    const y = base58Decode(b);
    if (x.length !== ADDRESS_BYTES || y.length !== ADDRESS_BYTES) return false;
    for (let i = 0; i < PARITY_INDEX; i++) {
      if (x[i] !== y[i]) return false;
    }
    return x[PARITY_INDEX] <= 1 && y[PARITY_INDEX] <= 1;
  } catch {
    return false;
  }
}

/** True when `address` is an existing owner or the negation of one; such an ADD_OWNER can never execute. */
export function conflictsWithOwner(address: string, owners: readonly string[]): boolean {
  return owners.some((owner) => sameKeyHolder(owner, address));
}
