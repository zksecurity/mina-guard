import type { Cache } from 'o1js';

const DB_NAME = 'o1js-compile-cache';
const STORE_NAME = 'keys';
const DB_VERSION = 1;
const MIN_QUOTA_BYTES = 1.8 * 1024 * 1024 * 1024; // 1.8GB free required to enable writes

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type Entry = { uniqueId: string; data: Uint8Array };

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

async function canWriteToIDB(userEnabled = true): Promise<boolean> {
  if (!userEnabled) {
    console.log('[idb-cache] writes disabled by user preference');
    return false;
  }
  if (!navigator.storage?.estimate) return true;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const remaining = quota - usage;
    const remainingMB = (remaining / 1024 / 1024).toFixed(0);
    if (remaining < MIN_QUOTA_BYTES) {
      console.log(
        `[idb-cache] skipping writes — only ${remainingMB}MB free (need ${(MIN_QUOTA_BYTES / 1024 / 1024).toFixed(0)}MB)`
      );
      return false;
    }
    console.log(`[idb-cache] writes enabled — ${remainingMB}MB available`);
    return true;
  } catch {
    return true;
  }
}

export async function clearCompileCache(): Promise<void> {
  const db = await openDB();
  const enabled = (await idbGet(db, '__cache_enabled__')) === false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (enabled) await setCompileCacheEnabledIDB(false);
  db.close();
}

export async function getCompileCacheSize(): Promise<{
  entries: number;
  bytes: number;
}> {
  try {
    const db = await openDB();
    const manifest = (await idbGet(db, '__manifest__')) as
      | Record<string, string>
      | undefined;
    if (!manifest) return { entries: 0, bytes: 0 };

    let bytes = 0;
    const keys = Object.keys(manifest);
    await Promise.all(
      keys.map(async (id) => {
        try {
          const record = (await idbGet(db, id)) as { blob: Blob } | undefined;
          if (record?.blob) bytes += record.blob.size;
        } catch {}
      })
    );
    db.close();
    return { entries: keys.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

export async function isCompileCacheEnabledIDB(): Promise<boolean> {
  try {
    const db = await openDB();
    const val = await idbGet(db, '__cache_enabled__');
    db.close();
    return val !== false;
  } catch {
    return true;
  }
}

export async function setCompileCacheEnabledIDB(enabled: boolean): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(enabled, '__cache_enabled__');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function createIndexedDBCache(): Promise<Cache> {
  const db = await openDB();
  const map = new Map<string, Entry>();

  const t0 = performance.now();

  const manifest = (await idbGet(db, '__manifest__')) as
    | Record<string, string>
    | undefined;

  if (manifest) {
    const keys = Object.keys(manifest);
    await Promise.all(
      keys.map(async (persistentId) => {
        try {
          const record = (await idbGet(db, persistentId)) as
            | { blob: Blob }
            | undefined;
          if (!record?.blob) return;
          const buf = await record.blob.arrayBuffer();
          map.set(persistentId, {
            uniqueId: manifest[persistentId],
            data: new Uint8Array(buf),
          });
        } catch {}
      })
    );
  }

  let totalBytes = 0;
  for (const entry of map.values()) totalBytes += entry.data.byteLength;
  console.log(
    `[idb-cache] preloaded ${map.size} entries (${(totalBytes / 1024 / 1024).toFixed(1)}MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`
  );

  const cacheEnabled = (await idbGet(db, '__cache_enabled__')) !== false;
  const writable = await canWriteToIDB(cacheEnabled);

  return {
    read(header) {
      const entry = map.get(header.persistentId);
      if (!entry || entry.uniqueId !== header.uniqueId) return undefined;
      if (header.dataType === 'string') return entry.data;
      return new Uint8Array(entry.data);
    },

    write(header, value) {
      const data = new Uint8Array(value);
      map.set(header.persistentId, { uniqueId: header.uniqueId, data });

      if (!writable) return;

      const blob = new Blob([data]);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ blob }, header.persistentId);

      const currentManifest: Record<string, string> = {};
      for (const [k, v] of map) currentManifest[k] = v.uniqueId;
      store.put(currentManifest, '__manifest__');
    },

    canWrite: true,
  };
}
