/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkup, plainText } from "./markup.ts";
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
