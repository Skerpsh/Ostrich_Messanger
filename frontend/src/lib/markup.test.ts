/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionedUsernames, parseMarkup, plainText } from "./markup.ts";
import { readFileSync } from "node:fs";
import { decodePayload, encodePayload } from "./payload.ts";

test("formatting", () => {
  assert.deepEqual(parseMarkup("a **b** c"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " c" },
  ]);
  assert.deepEqual(parseMarkup("_it_ and *it* ~~s~~ `x * y`"), [
    { text: "it", italic: true },
    { text: " and " },
    { text: "it", italic: true },
    { text: " " },
    { text: "s", strike: true },
    { text: " " },
    { text: "x * y", code: true },
  ]);
  assert.deepEqual(parseMarkup("**bold _both_**"), [
    { text: "bold ", bold: true },
    { text: "both", bold: true, italic: true },
  ]);
  assert.deepEqual(parseMarkup("```\nconst a = 1;\n```"), [{ text: "const a = 1;", code: true }]);
});

test("no formatting where it is not meant", () => {
  for (const text of ["snake_case_name", "2 * 3 * 4", "** not bold **", "a_b", "*", "**"]) {
    assert.equal(plainText(text), text, text);
  }
});

test("links", () => {
  assert.deepEqual(parseMarkup("see https://example.com/a?b=1."), [
    { text: "see " },
    { text: "https://example.com/a?b=1", link: "https://example.com/a?b=1" },
    { text: "." },
  ]);
  assert.deepEqual(parseMarkup("(https://x.org)"), [
    { text: "(" },
    { text: "https://x.org", link: "https://x.org" },
    { text: ")" },
  ]);
});

test("payloads", () => {
  assert.equal(encodePayload({ text: "hi" }), "hi");
  assert.deepEqual(decodePayload("hi"), { text: "hi" });

  const forwarded = encodePayload({ text: "hi", forwardedFrom: "alice" });
  assert.deepEqual(decodePayload(forwarded), { text: "hi", forwardedFrom: "alice" });

  // Broken payloads show as text.
  assert.deepEqual(decodePayload("\u001eostrich1:{oops"), { text: "\u001eostrich1:{oops" });
});

test("payloads with attachments", () => {
  const v = JSON.parse(
    readFileSync(new URL("../../../testdata/crypto-vectors.json", import.meta.url), "utf8"),
  );
  const payload = decodePayload(v.payload_with_attachments);

  assert.equal(payload.text, "caption");
  assert.equal(payload.forwardedFrom, "carol");
  assert.deepEqual(payload.attachments, [
    {
      id: "6f2b4ad0-8a3e-4c51-9d7b-1e2f3a4b5c6d",
      key: v.attachment_key,
      name: "photo.jpg",
      mime: "image/jpeg",
      size: 110,
      width: 640,
      height: 480,
    },
  ]);
  assert.equal(encodePayload(payload), v.payload_with_attachments);

  // Malformed attachments are left out.
  const broken = '\u001eostrich1:{"t":"x","a":[{"i":"nope"},{"i":1}]}';
  assert.deepEqual(decodePayload(broken), { text: "x" });
});

// The same cases as the CLI's (cli/markup_test.go).
test("mentions", () => {
  const { mentions } = JSON.parse(
    readFileSync(new URL("../../../testdata/markup-mentions.json", import.meta.url), "utf8"),
  ) as { mentions: [string, string[]][] };

  for (const [text, want] of mentions) {
    const got = parseMarkup(text)
      .filter((span) => span.mention && !span.code)
      .map((span) => span.mention);
    assert.deepEqual(got, want, text);
  }

  assert.deepEqual(mentionedUsernames("@Bob and @bob"), ["bob"]);
});
