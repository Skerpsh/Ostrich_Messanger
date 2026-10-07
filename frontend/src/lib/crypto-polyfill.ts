import { getRandomValues } from "expo-crypto";

// React Native has no Web Crypto; crypto.ts (and noble) need
// crypto.getRandomValues. Imported first by the root layout.
const globalCrypto = globalThis as { crypto?: { getRandomValues?: unknown } };

if (!globalCrypto.crypto?.getRandomValues) {
  globalCrypto.crypto = {
    ...(globalCrypto.crypto ?? {}),
    getRandomValues,
  };
}
