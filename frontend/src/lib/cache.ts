import { SQLiteStorage } from "expo-sqlite/kv-store";

// The local cache of chats, messages and the outbox, so the app opens at
// once and works offline. Messages are kept as the server sends them:
// end-to-end encrypted. iOS / Android: SQLite; the web implementation
// lives in cache.web.ts.

const store = new SQLiteStorage("ostrich-cache");

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const value = await store.getItemAsync(key);
    return value === null ? null : (JSON.parse(value) as T);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await store.setItemAsync(key, JSON.stringify(value));
  } catch {}
}

// Removes every entry whose key starts with prefix (e.g. an account's).
export async function cacheClear(prefix: string): Promise<void> {
  try {
    const keys = await store.getAllKeysAsync();
    await Promise.all(keys.filter((key) => key.startsWith(prefix)).map((key) => store.removeItemAsync(key)));
  } catch {}
}
