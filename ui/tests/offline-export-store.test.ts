import { describe, expect, it } from 'bun:test';
import { EMPTY_OFFLINE_EXPORTS, loadOfflineExports, offlineExportKey, saveOfflineExports } from '../lib/offline-export-store';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => { items.delete(key); },
    setItem: (key, value) => { items.set(key, String(value)); },
  };
}

const key = offlineExportKey('mainnet', 'B62qvault:12345');
const approve = { filename: 'approve-12345678-2026-11-05T10-00-00.json', fee: 100_000_000 };

describe('offline export store', () => {
  it('restores the saved export and selection', () => {
    const storage = memoryStorage();
    saveOfflineExports(key, { selected: 'approve', exports: { approve } }, storage);
    expect(loadOfflineExports(key, storage)).toEqual({ selected: 'approve', exports: { approve } });
  });

  it('keeps each network and proposal apart', () => {
    const storage = memoryStorage();
    saveOfflineExports(key, { selected: 'approve', exports: { approve } }, storage);
    expect(loadOfflineExports(offlineExportKey('testnet', 'B62qvault:12345'), storage)).toEqual(EMPTY_OFFLINE_EXPORTS);
    expect(loadOfflineExports(offlineExportKey('mainnet', 'B62qvault:99999'), storage)).toEqual(EMPTY_OFFLINE_EXPORTS);
  });

  it('removes the entry when nothing is exported', () => {
    const storage = memoryStorage();
    saveOfflineExports(key, { selected: 'approve', exports: { approve } }, storage);
    saveOfflineExports(key, EMPTY_OFFLINE_EXPORTS, storage);
    expect(storage.getItem(key)).toBeNull();
  });

  it('drops entries this page could not have written', () => {
    const storage = memoryStorage();
    storage.setItem(key, JSON.stringify({
      selected: 'delete',
      exports: {
        approve,
        execute: { filename: 'x; rm -rf ~.json', fee: 100_000_000 },
        propose: { filename: 'propose-1.json', fee: 1 },
        other: approve,
      },
    }));
    expect(loadOfflineExports(key, storage)).toEqual({ selected: null, exports: { approve } });
    storage.setItem(key, JSON.stringify({ exports: { execute: approve } }));
    expect(loadOfflineExports(key, storage)).toEqual(EMPTY_OFFLINE_EXPORTS);
    storage.setItem(key, '{not json');
    expect(loadOfflineExports(key, storage)).toEqual(EMPTY_OFFLINE_EXPORTS);
  });

  it('works without storage', () => {
    expect(loadOfflineExports(key, null)).toEqual(EMPTY_OFFLINE_EXPORTS);
    expect(() => saveOfflineExports(key, { selected: 'approve', exports: { approve } }, null)).not.toThrow();
  });
});
