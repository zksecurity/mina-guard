import { expect, it } from 'bun:test';
import { assertOfflineResponseVersion } from '../lib/offline-format';

it('accepts v1 signed responses and rejects unsupported and malformed versions', () => {
  expect(() => assertOfflineResponseVersion(1)).not.toThrow();
  for (const version of [2, 3, undefined, null, '1']) {
    expect(() => assertOfflineResponseVersion(version)).toThrow('Unsupported signed response version');
  }
});
