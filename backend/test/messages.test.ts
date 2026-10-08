import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupEpochOf,
  isEncryptedMessage,
  MAX_MESSAGE_LENGTH,
  needsClientId,
  withReply,
} from "../src/messages.js";

test("only encrypted messages are accepted", () => {
  assert.ok(isEncryptedMessage("e2:AAAA"));
  assert.ok(isEncryptedMessage("e1:AAAA=="));
  assert.ok(!isEncryptedMessage("hello"));
  assert.ok(!isEncryptedMessage("e3:AAAA"));
  assert.ok(!isEncryptedMessage("e2:AA AA"));
  assert.ok(!isEncryptedMessage("e2:" + "A".repeat(MAX_MESSAGE_LENGTH)));
});

test("e2 messages need the id chosen by the client", () => {
  assert.ok(needsClientId("e2:AAAA"));
  assert.ok(!needsClientId("e1:AAAA"));
});

test("reply columns become reply_to", () => {
  const empty = {
    reply_id: null,
    reply_sender_id: null,
    reply_sender_username: null,
    reply_sender_is_developer: null,
    reply_content: null,
  };

  assert.deepEqual(withReply({ id: "m", ...empty }), { id: "m", reply_to: null });

  assert.deepEqual(
    withReply({
      id: "m",
      reply_id: "r",
      reply_sender_id: "u",
      reply_sender_username: "alice",
      reply_sender_is_developer: null,
      reply_content: "e2:AAAA",
    }),
    {
      id: "m",
      reply_to: {
        id: "r",
        sender_id: "u",
        sender_username: "alice",
        sender_is_developer: false,
        content: "e2:AAAA",
      },
    },
  );
});

test("group messages carry their key epoch", () => {
  assert.ok(isEncryptedMessage("e3:12:AAAA"));
  assert.ok(!isEncryptedMessage("e3:AAAA"));
  assert.ok(!isEncryptedMessage("e3:x:AAAA"));
  assert.ok(needsClientId("e3:1:AAAA"));
  assert.equal(groupEpochOf("e3:12:AAAA"), 12);
  assert.equal(groupEpochOf("e2:AAAA"), null);
});
