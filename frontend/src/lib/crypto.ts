// End-to-end encryption. The CLI (cli/crypto.go) implements the same
// scheme; keep them in step (crypto.test.ts and cli/crypto_test.go check
// both against testdata/crypto-vectors.json).
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
// Messages: "e2:" + base64(nonce(24) ‖ XChaCha20-Poly1305(chat key, nonce,
//                   UTF-8 text, aad))
//   aad = "ostrich/v2 message" 0 chat id 0 sender id 0 message id
// The client chooses the message id, so the server can neither move a
// message to another sender or message nor send it again as a new one.
// "e1:" messages (older clients) use aad = chat id only.
//
// Attachments: each file is encrypted with its own random key,
//   base64(nonce(24) ‖ XChaCha20-Poly1305(file key, nonce, file,
//   aad "ostrich/v1 attachment")),
// uploaded under an id the client chooses; the key travels inside the
// message (payload.ts), so the server stores only ciphertext.
//
// Groups: messages are encrypted with a group key; a new key ("epoch")
// is made when a member leaves or is removed. Whoever makes a key wraps it
// for every member:
//   wrap key = HKDF(X25519(own private, member's public), salt chat id,
//                   info "ostrich/v1 group key-wrap", 32)
//   wrapped  = base64(nonce(24) ‖ XChaCha20-Poly1305(wrap key, nonce,
//              group key, aad "ostrich/v1 group key" 0 chat 0 epoch 0 member))
//   messages = "e3:" epoch ":" base64(nonce(24) ‖ XChaCha20-Poly1305(group
//              key, nonce, text, aad "ostrich/v3 group message" 0 chat 0
//              sender 0 message 0 epoch))
//   info     = "i1:" epoch ":" … the group's name and photo (JSON), aad
//              "ostrich/v1 group info" 0 chat 0 epoch
// The server keeps the wrapped keys and never has a group key. Members
// share the key, so within a group a member (with the server's help)
// could pass a message off as another member's; outsiders and the server
// cannot read or forge anything.
//
// Safety code: both members compute the same 40 digits from the two
// public keys; if they match on both devices, the server has not swapped
// the keys (see safetyCode()).
//
// The OstrichID is ~99 random bits, so a fast KDF is enough: it cannot be
// guessed from the auth key or from anything the server stores.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ID_LENGTH = 20;
const SALT = utf8("ostrich/v1");
const PRIVATE_KEY_AAD = utf8("ostrich/v1 private-key");
const CHAT_INFO = utf8("ostrich/v1 chat");
const SAFETY_INFO = utf8("ostrich/v1 safety");
const ATTACHMENT_AAD = utf8("ostrich/v1 attachment");
const GROUP_WRAP_INFO = utf8("ostrich/v1 group key-wrap");
const PREFIX_GROUP = "e3:";
const PREFIX_INFO = "i1:";
const MESSAGE_AAD = "ostrich/v2 message";
const PREFIX_V1 = "e1:";
const PREFIX_V2 = "e2:";

function utf8(text: string) {
  return new TextEncoder().encode(text);
}

// The apps install crypto.getRandomValues (crypto-polyfill.ts); browsers
// and Node have it.
function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
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
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(derived.wrapKey, nonce, PRIVATE_KEY_AAD).encrypt(
    privateKey,
  );

  return {
    privateKey,
    material: {
      auth_key: derived.authKey,
      public_key: publicKeyOf(privateKey),
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

// base64 of the public key that belongs to a private key.
export function publicKeyOf(privateKey: Uint8Array) {
  return toBase64(x25519.getPublicKey(privateKey));
}

// --- safety code ---

// 40 digits in 8 groups, the same for both members of a chat: SHA-256 of
// the two public keys (in a fixed order), each 4 bytes taken mod 100000.
export function safetyCode(publicKeyA: string, publicKeyB: string): string[] {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const hash = sha256(concat(SAFETY_INFO, concat(fromBase64(first), fromBase64(second))));
  const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
  const groups: string[] = [];

  for (let i = 0; i < 8; i++) {
    groups.push(String(view.getUint32(i * 4) % 100000).padStart(5, "0"));
  }

  return groups;
}

// --- messages ---

// Chat keys by own private key, peer key and chat; forgotten on logout.
const chatKeys = new Map<string, Uint8Array>();

export function clearChatKeys() {
  chatKeys.clear();
}

function chatKey(privateKey: Uint8Array, peerPublicKey: string, chatId: string) {
  const cacheKey = `${toHex(privateKey.subarray(0, 8))}:${chatId}:${peerPublicKey}`;
  let key = chatKeys.get(cacheKey);

  if (!key) {
    const shared = x25519.getSharedSecret(privateKey, fromBase64(peerPublicKey));
    key = hkdf(sha256, shared, utf8(chatId), CHAT_INFO, 32);
    chatKeys.set(cacheKey, key);
  }

  return key;
}

function messageAad(chatId: string, senderId: string, messageId: string) {
  return utf8(`${MESSAGE_AAD}\0${chatId}\0${senderId}\0${messageId}`);
}

// A random UUID (v4) for a new message: the encryption is bound to it.
export function newMessageId() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Who wrote a message and its id: the encryption is bound to both.
export type MessageRef = {
  id: string;
  sender_id: string;
};

export function encryptMessage(
  text: string,
  message: MessageRef,
  privateKey: Uint8Array,
  peerPublicKey: string,
  chatId: string,
): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(
    chatKey(privateKey, peerPublicKey, chatId),
    nonce,
    messageAad(chatId, message.sender_id, message.id),
  ).encrypt(utf8(text));

  return PREFIX_V2 + toBase64(concat(nonce, sealed));
}

// ok: decrypted; plain: not encrypted at all (from before end-to-end
// encryption, or put there by the server); error: cannot be decrypted.
export type Decrypted = {
  status: "ok" | "plain" | "error";
  text: string;
};

const UNREADABLE = "Can't decrypt this message";

export function decryptMessage(
  message: MessageRef & { content: string },
  privateKey: Uint8Array | null,
  peerPublicKey: string | null,
  chatId: string,
): Decrypted {
  const { content } = message;
  const v2 = content.startsWith(PREFIX_V2);

  if (!v2 && !content.startsWith(PREFIX_V1)) {
    return { status: "plain", text: content };
  }

  if (!privateKey || !peerPublicKey) {
    return { status: "error", text: UNREADABLE };
  }

  try {
    const data = fromBase64(content.slice(PREFIX_V2.length));
    const plain = xchacha20poly1305(
      chatKey(privateKey, peerPublicKey, chatId),
      data.subarray(0, 24),
      v2 ? messageAad(chatId, message.sender_id, message.id) : utf8(chatId),
    ).decrypt(data.subarray(24));

    return { status: "ok", text: new TextDecoder().decode(plain) };
  } catch {
    return { status: "error", text: UNREADABLE };
  }
}

// --- attachments ---

// Encrypts a file with a new key: the sealed bytes to upload and the key
// (base64) for the message.
export function encryptAttachment(data: Uint8Array): { key: string; sealed: Uint8Array } {
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(key, nonce, ATTACHMENT_AAD).encrypt(data);

  return { key: toBase64(key), sealed: concat(nonce, sealed) };
}

// Decrypts a downloaded file; throws if it is not the file of that key.
export function decryptAttachment(sealed: Uint8Array, key: string): Uint8Array {
  return xchacha20poly1305(fromBase64(key), sealed.subarray(0, 24), ATTACHMENT_AAD).decrypt(
    sealed.subarray(24),
  );
}

// --- groups ---

export function newGroupKey() {
  return randomBytes(32);
}

function groupWrapKey(privateKey: Uint8Array, otherPublicKey: string, chatId: string) {
  const shared = x25519.getSharedSecret(privateKey, fromBase64(otherPublicKey));
  return hkdf(sha256, shared, utf8(chatId), GROUP_WRAP_INFO, 32);
}

function groupKeyAad(chatId: string, epoch: number, memberId: string) {
  return utf8(`ostrich/v1 group key\0${chatId}\0${epoch}\0${memberId}`);
}

// Wraps a group key for a member (with their public key).
export function wrapGroupKey(
  groupKey: Uint8Array,
  epoch: number,
  chatId: string,
  privateKey: Uint8Array,
  memberId: string,
  memberPublicKey: string,
): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(
    groupWrapKey(privateKey, memberPublicKey, chatId),
    nonce,
    groupKeyAad(chatId, epoch, memberId),
  ).encrypt(groupKey);

  return toBase64(concat(nonce, sealed));
}

// Unwraps the group key wrapped for this user by `wrapperPublicKey`'s
// owner; throws if it is not.
export function unwrapGroupKey(
  wrapped: string,
  epoch: number,
  chatId: string,
  privateKey: Uint8Array,
  ownId: string,
  wrapperPublicKey: string,
): Uint8Array {
  const data = fromBase64(wrapped);

  return xchacha20poly1305(
    groupWrapKey(privateKey, wrapperPublicKey, chatId),
    data.subarray(0, 24),
    groupKeyAad(chatId, epoch, ownId),
  ).decrypt(data.subarray(24));
}

function groupMessageAad(chatId: string, message: MessageRef, epoch: number) {
  return utf8(
    `ostrich/v3 group message\0${chatId}\0${message.sender_id}\0${message.id}\0${epoch}`,
  );
}

export function encryptGroupMessage(
  text: string,
  message: MessageRef,
  groupKey: Uint8Array,
  epoch: number,
  chatId: string,
): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(groupKey, nonce, groupMessageAad(chatId, message, epoch)).encrypt(
    utf8(text),
  );

  return `${PREFIX_GROUP}${epoch}:${toBase64(concat(nonce, sealed))}`;
}

// "e3:<epoch>:…" / "i1:<epoch>:…" → the epoch and the sealed bytes.
function splitEpoch(content: string, prefix: string) {
  const match = new RegExp(`^${prefix}(\\d{1,9}):([A-Za-z0-9+/]+={0,2})$`).exec(content);

  return match ? { epoch: Number(match[1]), data: fromBase64(match[2]) } : null;
}

// The epoch of a group message, or null for other messages.
export function groupMessageEpoch(content: string) {
  return splitEpoch(content, PREFIX_GROUP)?.epoch ?? null;
}

export function isGroupMessage(content: string) {
  return content.startsWith(PREFIX_GROUP);
}

export function decryptGroupMessage(
  message: MessageRef & { content: string },
  keyOf: (epoch: number) => Uint8Array | undefined,
  chatId: string,
): Decrypted {
  const parts = splitEpoch(message.content, PREFIX_GROUP);
  const key = parts && keyOf(parts.epoch);

  if (!parts || !key) {
    return { status: "error", text: UNREADABLE };
  }

  try {
    const plain = xchacha20poly1305(
      key,
      parts.data.subarray(0, 24),
      groupMessageAad(chatId, message, parts.epoch),
    ).decrypt(parts.data.subarray(24));

    return { status: "ok", text: new TextDecoder().decode(plain) };
  } catch {
    return { status: "error", text: UNREADABLE };
  }
}

// What a group's members see of it; the server never does.
export type GroupInfo = {
  name: string;
  // An encrypted picture (an attachment of the chat).
  photo?: { id: string; key: string; mime: string };
};

const groupInfoAad = (chatId: string, epoch: number) =>
  utf8(`ostrich/v1 group info\0${chatId}\0${epoch}`);

export function encryptGroupInfo(info: GroupInfo, groupKey: Uint8Array, epoch: number, chatId: string) {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(groupKey, nonce, groupInfoAad(chatId, epoch)).encrypt(
    utf8(JSON.stringify(info)),
  );

  return `${PREFIX_INFO}${epoch}:${toBase64(concat(nonce, sealed))}`;
}

export function groupInfoEpoch(encrypted: string) {
  return splitEpoch(encrypted, PREFIX_INFO)?.epoch ?? null;
}

// The group's info, or null if it cannot be read (yet).
export function decryptGroupInfo(
  encrypted: string,
  keyOf: (epoch: number) => Uint8Array | undefined,
  chatId: string,
): GroupInfo | null {
  const parts = splitEpoch(encrypted, PREFIX_INFO);
  const key = parts && keyOf(parts.epoch);

  if (!parts || !key) {
    return null;
  }

  try {
    const plain = xchacha20poly1305(key, parts.data.subarray(0, 24), groupInfoAad(chatId, parts.epoch)).decrypt(
      parts.data.subarray(24),
    );
    const info = JSON.parse(new TextDecoder().decode(plain)) as Partial<GroupInfo>;

    if (typeof info.name !== "string") {
      return null;
    }

    const photo = info.photo;

    return {
      name: info.name,
      ...(photo && typeof photo.id === "string" && typeof photo.key === "string" && typeof photo.mime === "string"
        ? { photo: { id: photo.id, key: photo.key, mime: photo.mime } }
        : {}),
    };
  } catch {
    return null;
  }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
