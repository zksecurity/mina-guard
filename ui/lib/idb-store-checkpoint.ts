import type { StoreCheckpoint } from 'contracts';

const DATABASE = 'minaguard-store-checkpoints-v1';
const STORE = 'vaults';

async function access(key: string, value?: StoreCheckpoint): Promise<StoreCheckpoint | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Checkpoint storage is blocked'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, value ? 'readwrite' : 'readonly');
      const store = tx.objectStore(STORE);
      const request = value ? store.put(value, key) : store.get(key);
      tx.oncomplete = () => resolve(value ? undefined : request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const readStoreCheckpoint = (key: string) => access(key);
export const writeStoreCheckpoint = async (key: string, value: StoreCheckpoint) => { await access(key, value); };
