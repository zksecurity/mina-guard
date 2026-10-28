import { expect, it } from 'bun:test';
import { assertOfflineResponseVersion, signedOwnerFeeNanomina } from '../lib/offline-format';

it('accepts v1 signed responses and rejects unsupported and malformed versions', () => {
  expect(() => assertOfflineResponseVersion(1)).not.toThrow();
  for (const version of [2, 3, undefined, null, '1']) {
    expect(() => assertOfflineResponseVersion(version)).toThrow('Unsupported signed response version');
  }
});

it('checks the actual signed fee before an offline response can be broadcast', () => {
  const transaction = (fee: unknown) => ({ feePayer: { body: { fee } } });
  expect(signedOwnerFeeNanomina(transaction('20000000'), 20_000_000)).toBe(20_000_000);
  expect(() => signedOwnerFeeNanomina(transaction('20000000'), 30_000_000)).toThrow('differs from the exported request');
  for (const fee of ['9999999', '100000001']) {
    expect(() => signedOwnerFeeNanomina(transaction(fee))).toThrow('outside the allowed');
  }
  for (const fee of [undefined, null, 20_000_000, '020000000', '20.0', '-20000000']) {
    expect(() => signedOwnerFeeNanomina(transaction(fee))).toThrow('no valid fee');
  }
  expect(() => signedOwnerFeeNanomina({})).toThrow('no valid fee');
});
