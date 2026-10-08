/// <reference types="node" />
// npm test. The same vectors are checked by cli/crypto_test.go, so the
// app and the CLI can read each other's messages.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  decryptAttachment,
  decryptGroupInfo,
  decryptGroupMessage,
  decryptMessage,
  encryptAttachment,
  encryptGroupInfo,
  encryptGroupMessage,
  groupMessageEpoch,
  newGroupKey,
  unwrapGroupKey,
  wrapGroupKey,
  deriveFromOstrichId,
  encryptMessage,
  fromBase64,
  newMessageId,
  normalizeOstrichId,
  openPrivateKey,
  publicKeyOf,
  safetyCode,
  toBase64,
} from "./crypto.ts";

const v = JSON.parse(
  readFileSync(new URL("../../../testdata/crypto-vectors.json", import.meta.url), "utf8"),
);

const privateA = fromBase64(v.private_key_a);
const privateB = fromBase64(v.private_key_b);

test("OstrichID → auth key and account key", () => {
  const id = normalizeOstrichId(v.ostrich_id.toLowerCase().replaceAll("-", " "));
  assert.ok(id !== null);

  const derived = deriveFromOstrichId(id);
  assert.equal(derived.authKey, v.auth_key);
  assert.deepEqual(openPrivateKey(derived, v.encrypted_private_key_a), privateA);
  assert.equal(publicKeyOf(privateA), v.public_key_a);
});

test("invalid OstrichIDs are rejected", () => {
  assert.equal(normalizeOstrichId("too-short"), null);
  // 0, O, 1, I and L are not in the alphabet.
  assert.equal(normalizeOstrichId("0OIL-2222-2222-2222-2222"), null);
});

test("e2 message from A, read by B", () => {
  const message = { id: v.message_id, sender_id: v.sender_id, content: v.message_e2 };

  assert.deepEqual(decryptMessage(message, privateB, v.public_key_a, v.chat_id), {
    status: "ok",
    text: v.text,
  });
});

test("e2 is bound to its sender, id and chat", () => {
  const message = { id: v.message_id, sender_id: v.sender_id, content: v.message_e2 };
  const other = newMessageId();

  for (const changed of [
    { ...message, sender_id: other },
    { ...message, id: other },
  ]) {
    assert.equal(decryptMessage(changed, privateB, v.public_key_a, v.chat_id).status, "error");
  }

  assert.equal(decryptMessage(message, privateB, v.public_key_a, other).status, "error");
});

test("e1 message (older clients)", () => {
  const message = { id: newMessageId(), sender_id: newMessageId(), content: v.message_e1 };

  assert.deepEqual(decryptMessage(message, privateB, v.public_key_a, v.chat_id), {
    status: "ok",
    text: v.text_e1,
  });
});

test("plain text is reported as not encrypted", () => {
  const message = { id: newMessageId(), sender_id: v.sender_id, content: "hello" };

  assert.deepEqual(decryptMessage(message, privateB, v.public_key_a, v.chat_id), {
    status: "plain",
    text: "hello",
  });
});

test("round trip", () => {
  const ref = { id: newMessageId(), sender_id: v.sender_id };
  const content = encryptMessage("round trip ✓", ref, privateA, v.public_key_b, v.chat_id);

  assert.equal(
    decryptMessage({ ...ref, content }, privateB, v.public_key_a, v.chat_id).text,
    "round trip ✓",
  );
});

test("safety code is the same on both sides", () => {
  assert.deepEqual(safetyCode(v.public_key_a, v.public_key_b), v.safety_code);
  assert.deepEqual(safetyCode(v.public_key_b, v.public_key_a), v.safety_code);
});

test("message ids are UUID v4", () => {
  assert.match(newMessageId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("base64 round trip", () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) & 255);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  }
});

test("attachments: shared vector and round trip", () => {
  assert.deepEqual(
    decryptAttachment(fromBase64(v.attachment_sealed), v.attachment_key),
    fromBase64(v.attachment_plain),
  );

  const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
  const { key, sealed } = encryptAttachment(data);
  assert.deepEqual(decryptAttachment(sealed, key), data);

  // Another key does not open it.
  assert.throws(() => decryptAttachment(sealed, encryptAttachment(data).key));
});

test("groups: shared vectors", () => {
  // B unwraps the key A wrapped for them, then reads the message and info.
  const key = unwrapGroupKey(v.group_key_wrapped_for_b, v.group_epoch, v.group_id, privateB, v.member_id_b, v.public_key_a);
  assert.equal(toBase64(key), v.group_key);

  const keyOf = (epoch: number) => (epoch === v.group_epoch ? key : undefined);
  const message = { id: v.message_id, sender_id: v.sender_id, content: v.group_message };

  assert.equal(groupMessageEpoch(v.group_message), v.group_epoch);
  assert.deepEqual(decryptGroupMessage(message, keyOf, v.group_id), { status: "ok", text: v.group_text });
  assert.deepEqual(decryptGroupInfo(v.group_info, keyOf, v.group_id), { name: "Ostrich team 🦤" });

  // Bound to the sender, the message, the chat and the epoch.
  assert.equal(decryptGroupMessage({ ...message, sender_id: v.member_id_b }, keyOf, v.group_id).status, "error");
  assert.equal(decryptGroupMessage(message, keyOf, v.chat_id).status, "error");
  assert.equal(decryptGroupMessage(message, () => undefined, v.group_id).status, "error");
});

test("groups: a wrapped key is only for its member and epoch", () => {
  const key = newGroupKey();
  const wrapped = wrapGroupKey(key, 1, v.group_id, privateA, v.member_id_b, v.public_key_b);

  assert.deepEqual(unwrapGroupKey(wrapped, 1, v.group_id, privateB, v.member_id_b, v.public_key_a), key);
  assert.throws(() => unwrapGroupKey(wrapped, 2, v.group_id, privateB, v.member_id_b, v.public_key_a));
  assert.throws(() => unwrapGroupKey(wrapped, 1, v.group_id, privateB, v.sender_id, v.public_key_a));

  const content = encryptGroupMessage("round trip", { id: v.message_id, sender_id: v.sender_id }, key, 1, v.group_id);
  const keyOf = (epoch: number) => (epoch === 1 ? key : undefined);
  assert.equal(decryptGroupMessage({ id: v.message_id, sender_id: v.sender_id, content }, keyOf, v.group_id).text, "round trip");
  assert.deepEqual(decryptGroupInfo(encryptGroupInfo({ name: "x", photo: { id: v.message_id, key: "k", mime: "image/jpeg" } }, key, 1, v.group_id), keyOf, v.group_id), {
    name: "x",
    photo: { id: v.message_id, key: "k", mime: "image/jpeg" },
  });
});
