// End-to-end encryption. The CLI (cli/crypto.go) implements the same
// scheme; keep them in step.
//
// OstrichID: 20 random symbols from OSTRICH_ID_ALPHABET, generated on the
// client and shown to the user once. It never reaches the server.
//
// From the normalized ID (no dashes, upper case), with HKDF-SHA256 and
// salt "ostrich/v1":
//   auth key  = HKDF(id, info "auth", 32)      → sent as hex at login; the
//               server keeps its SHA-256
//   wrap key  = HKDF(id, info "key-wrap", 32)  → encrypts the private key
//
// Account keys: a random X25519 key pair. The server stores the public key
// and the private key encrypted with the wrap key:
//   encrypted_private_key = base64(nonce(24) ‖ XChaCha20-Poly1305(
//                             wrap key, nonce, private key, aad "ostrich/v1 private-key"))
// so every device that knows the OstrichID gets the private key.
//
// Chats: both members derive the same key
//   chat key = HKDF(X25519(own private, other's public), salt chat id,
//                   info "ostrich/v1 chat", 32)
// Messages: "e1:" + base64(nonce(24) ‖ XChaCha20-Poly1305(chat key, nonce,
//                   UTF-8 text, aad chat id))
//
// The OstrichID is ~99 random bits, so a fast KDF is enough: it cannot be
// guessed from the auth key or from anything the server stores.

import { getRandomValues } from "expo-crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

// React Native has no Web Crypto; noble needs crypto.getRandomValues.
const globalCrypto = globalThis as { crypto?: { getRandomValues?: unknown } };

if (!globalCrypto.crypto?.getRandomValues) {
  globalCrypto.crypto = {
    ...(globalCrypto.crypto ?? {}),
    getRandomValues,
  };
}

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ID_LENGTH = 20;
const SALT = utf8("ostrich/v1");
const PRIVATE_KEY_AAD = utf8("ostrich/v1 private-key");
const CHAT_INFO = utf8("ostrich/v1 chat");
const MESSAGE_PREFIX = "e1:";

function utf8(text: string) {
  return new TextEncoder().encode(text);
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array) {
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }

  return out;
}

export function fromBase64(text: string) {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;

  for (const char of clean) {
    const digit = BASE64.indexOf(char);

    if (digit < 0) {
      throw new Error("invalid base64");
    }

    value = (value << 6) | digit;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }

  return out;
}

// --- OstrichID ---

export function generateOstrichId(): string {
  // Rejection sampling: 31 symbols, so values ≥ 248 would bias the choice.
  let id = "";

  while (id.length < ID_LENGTH) {
    for (const byte of randomBytes(32)) {
      if (byte < 248 && id.length < ID_LENGTH) {
        id += ALPHABET[byte % ALPHABET.length];
      }
    }
  }

  return id;
}

// "K7QM-3XRA-9TPW-H2DC-M8VN"
export function formatOstrichId(id: string) {
  return id.match(/.{1,4}/g)!.join("-");
}

// The canonical form of a typed ID, or null if it cannot be valid.
export function normalizeOstrichId(input: string): string | null {
  const id = input.replace(/[\s-]/g, "").toUpperCase();

  if (id.length !== ID_LENGTH || [...id].some((c) => !ALPHABET.includes(c))) {
    return null;
  }

  return id;
}

// --- account keys ---

export type DerivedKeys = {
  // Sent at login, hex.
  authKey: string;
  // Encrypts the private key; never leaves the device.
  wrapKey: Uint8Array;
};

export function deriveFromOstrichId(normalizedId: string): DerivedKeys {
  const ikm = utf8(normalizedId);

  return {
    authKey: toHex(hkdf(sha256, ikm, SALT, utf8("auth"), 32)),
    wrapKey: hkdf(sha256, ikm, SALT, utf8("key-wrap"), 32),
  };
}

// What the server stores for an account (see backend keyMaterialSchema).
export type KeyMaterial = {
  auth_key: string;
  public_key: string;
  encrypted_private_key: string;
};

// A new key pair for the account, the private key encrypted for storage.
export function createAccountKeys(derived: DerivedKeys): {
  material: KeyMaterial;
  privateKey: Uint8Array;
} {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(derived.wrapKey, nonce, PRIVATE_KEY_AAD).encrypt(
    privateKey,
  );

  return {
    privateKey,
    material: {
      auth_key: derived.authKey,
      public_key: toBase64(publicKey),
      encrypted_private_key: toBase64(concat(nonce, sealed)),
    },
  };
}

// The account's private key; throws if the OstrichID is wrong.
export function openPrivateKey(
  derived: DerivedKeys,
  encryptedPrivateKey: string,
): Uint8Array {
  const data = fromBase64(encryptedPrivateKey);

  return xchacha20poly1305(
    derived.wrapKey,
    data.subarray(0, 24),
    PRIVATE_KEY_AAD,
  ).decrypt(data.subarray(24));
}

// --- messages ---

const chatKeys = new Map<string, Uint8Array>();

function chatKey(privateKey: Uint8Array, peerPublicKey: string, chatId: string) {
  const cacheKey = `${chatId}:${peerPublicKey}`;
  let key = chatKeys.get(cacheKey);

  if (!key) {
    const shared = x25519.getSharedSecret(privateKey, fromBase64(peerPublicKey));
    key = hkdf(sha256, shared, utf8(chatId), CHAT_INFO, 32);
    chatKeys.set(cacheKey, key);
  }

  return key;
}

export function encryptMessage(
  text: string,
  privateKey: Uint8Array,
  peerPublicKey: string,
  chatId: string,
): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(
    chatKey(privateKey, peerPublicKey, chatId),
    nonce,
    utf8(chatId),
  ).encrypt(utf8(text));

  return MESSAGE_PREFIX + toBase64(concat(nonce, sealed));
}

export type Decrypted =
  | { ok: true; text: string; encrypted: boolean }
  | { ok: false; text: string; encrypted: true };

const UNREADABLE = "Can't decrypt this message";

// Messages from before end-to-end encryption are plain text and shown as
// they are.
export function decryptMessage(
  content: string,
  privateKey: Uint8Array | null,
  peerPublicKey: string | null,
  chatId: string,
): Decrypted {
  if (!content.startsWith(MESSAGE_PREFIX)) {
    return { ok: true, text: content, encrypted: false };
  }

  if (!privateKey || !peerPublicKey) {
    return { ok: false, text: UNREADABLE, encrypted: true };
  }

  try {
    const data = fromBase64(content.slice(MESSAGE_PREFIX.length));
    const plain = xchacha20poly1305(
      chatKey(privateKey, peerPublicKey, chatId),
      data.subarray(0, 24),
      utf8(chatId),
    ).decrypt(data.subarray(24));

    return { ok: true, text: new TextDecoder().decode(plain), encrypted: true };
  } catch {
    return { ok: false, text: UNREADABLE, encrypted: true };
  }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
