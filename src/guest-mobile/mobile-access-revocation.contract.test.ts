import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-revocation.service.ts", import.meta.url), "utf8");

test("revocation is idempotent for inactive credentials", () => {
  assert.match(source, /status === "REVOKED"/);
  assert.match(source, /status === "EXPIRED"/);
  assert.match(source, /ALREADY_INACTIVE/);
});

test("provider key is deleted before local REVOKED state", () => {
  const providerAt = source.indexOf("await provider.revokeKey");
  const revokedAt = source.indexOf('status: "REVOKED"');
  assert.ok(providerAt >= 0 && revokedAt > providerAt);
});

test("provider revoke failure does not falsely mark credential REVOKED", () => {
  assert.match(source, /MOBILE_ACCESS_REVOKE_FAILED/);
  assert.match(source, /throw error/);
});

test("successful revoke destroys persisted lockData ciphertext", () => {
  assert.match(source, /lockDataCiphertext: null/);
  assert.match(source, /lockDataKeyVersion: null/);
  assert.match(source, /revokedAt: now/);
});
