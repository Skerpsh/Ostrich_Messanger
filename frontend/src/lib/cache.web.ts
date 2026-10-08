// Web: the local cache in IndexedDB (localStorage is too small for
// message history). See cache.ts. Every call is guarded: IndexedDB may be
// missing (static rendering) or refused (some private browsing modes).

const DB_NAME = "ostrich-cache";
const STORE = "kv";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return opening;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await open();

  return new Promise<T>((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const value = await run<string | undefined>("readonly", (store) => store.get(key));
    return value === undefined ? null : (JSON.parse(value) as T);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(JSON.stringify(value), key));
  } catch {}
}

export async function cacheClear(prefix: string): Promise<void> {
  try {
    // Keys from prefix up to prefix followed by the highest character.
    await run("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, prefix + "￿")));
  } catch {}
}
