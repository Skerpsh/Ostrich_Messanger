import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authKeyMatches,
  hashAuthKey,
  hashOstrichId,
  nextUsernameChangeAt,
  normalizeOstrichId,
  ostrichIdMatches,
  USERNAME_CHANGE_INTERVAL_DAYS,
} from "../src/accounts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("OstrichIDs are accepted as typed", () => {
  assert.equal(normalizeOstrichId("k7qm-3xra 9tpw-h2dc-m8vn"), "K7QM3XRA9TPWH2DCM8VN");
  assert.equal(normalizeOstrichId("K7QM-3XRA"), null);
  // 0, O, 1, I and L are not in the alphabet.
  assert.equal(normalizeOstrichId("0OIL-2222-2222-2222-2222"), null);
});

test("OstrichID and auth key checks", () => {
  const id = "K7QM3XRA9TPWH2DCM8VN";
  assert.ok(ostrichIdMatches("k7qm-3xra-9tpw-h2dc-m8vn", hashOstrichId(id)));
  assert.ok(!ostrichIdMatches("K7QM-3XRA-9TPW-H2DC-M8VM", hashOstrichId(id)));

  const authKey = "ab".repeat(32);
  assert.ok(authKeyMatches(authKey, hashAuthKey(authKey)));
  assert.ok(!authKeyMatches("cd".repeat(32), hashAuthKey(authKey)));
  assert.ok(!authKeyMatches(undefined, hashAuthKey(authKey)));
  assert.ok(!authKeyMatches("not hex", hashAuthKey(authKey)));
});

test("username changes: once per interval", () => {
  assert.equal(nextUsernameChangeAt(null), null);

  const recent = new Date(Date.now() - DAY_MS);
  assert.equal(
    nextUsernameChangeAt(recent)?.getTime(),
    recent.getTime() + USERNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
  );

  const old = new Date(Date.now() - (USERNAME_CHANGE_INTERVAL_DAYS + 1) * DAY_MS);
  assert.equal(nextUsernameChangeAt(old), null);
});
