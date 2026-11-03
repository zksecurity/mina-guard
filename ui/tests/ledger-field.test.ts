import { describe, expect, it } from 'bun:test';
import { fieldToBytes, ledgerHashDisplay } from '../lib/ledger-field';

describe('Ledger field element display', () => {
  it('sends the field little-endian and shows it big-endian, as the device does', () => {
    const value = 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20n;
    const bytes = fieldToBytes(value);
    expect(bytes[0]).toBe(0x20);
    expect(bytes[31]).toBe(0x01);
    expect(ledgerHashDisplay(value)).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
  });

  it('pads to 64 lowercase hex digits and accepts decimal strings', () => {
    expect(ledgerHashDisplay('255')).toBe(`${'0'.repeat(62)}ff`);
    const decimal = '28948022309329048855892746252171976963363056481941647379679742748393362948096';
    expect(ledgerHashDisplay(decimal)).toBe(BigInt(decimal).toString(16).padStart(64, '0'));
  });

  it('refuses a value that does not fit the 32 bytes the device receives', () => {
    expect(() => fieldToBytes(1n << 256n)).toThrow('does not fit');
    expect(() => fieldToBytes(-1n)).toThrow('does not fit');
  });
});
