/**
 * How a single field element travels to the Ledger Mina app and how the
 * device shows it. MinaGuard signs approvals and fee payments with the
 * device's "sign field element" command, which carries only this 32-byte
 * value. The device cannot show recipients, amounts, fee or memo; it shows
 * the value as a "hash" so the user can compare it with the screen.
 */

/** Converts a field element to the 32-byte little-endian form the device expects. */
export function fieldToBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new Error('Field element does not fit in 32 bytes');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
  return bytes;
}

/**
 * The text the Ledger Mina app shows under "hash" for a field element: the
 * 32 bytes read back in big-endian order as 64 lowercase hex digits (Ledger
 * Mina app `bytes_to_hex_display`, src/utils.c, v1.6.5 to v1.6.7).
 */
export function ledgerHashDisplay(value: string | bigint): string {
  const bytes = fieldToBytes(typeof value === 'bigint' ? value : BigInt(value));
  let hex = '';
  for (let i = bytes.length - 1; i >= 0; i--) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
