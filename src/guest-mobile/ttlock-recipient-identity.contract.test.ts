import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const schema = await fs.readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const lifecycle = await fs.readFile(new URL("./ttlock-recipient-lifecycle.service.ts", import.meta.url), "utf8");
const crypto = await fs.readFile(new URL("./mobile-access-crypto.service.ts", import.meta.url), "utf8");

test("TTLock recipient identity is unique per GuestPerson and stores only ciphertext secrets", () => {
  const start = schema.indexOf("model TTLockRecipientIdentity");
  const block = schema.slice(start, schema.indexOf("\n}", start) + 2);
  assert.match(block, /guestPersonId\s+String\s+@unique/);
  assert.match(block, /passwordCiphertext/);
  assert.match(block, /accessTokenCiphertext/);
  assert.match(block, /refreshTokenCiphertext/);
  assert.doesNotMatch(block, /\n\s*password\s+String/);
  assert.doesNotMatch(block, /\n\s*accessToken\s+String/);
  assert.doesNotMatch(block, /\n\s*refreshToken\s+String/);
});

test("recipient deletion is blocked while a pending or active mobile credential remains", () => {
  assert.match(lifecycle, /mobileAccessCredential\.count/);
  assert.match(lifecycle, /status: \{ in: \["PENDING", "ACTIVE"\] \}/);
  assert.match(lifecycle, /ACTIVE_MOBILE_CREDENTIALS/);
  assert.match(lifecycle, /DELETE_PENDING/);
});

test("recipient secrets use the same versioned AES-GCM primitive with caller-specific AAD", () => {
  assert.match(crypto, /encryptMobileAccessSecret/);
  assert.match(crypto, /aes-256-gcm/);
  assert.match(crypto, /setAAD/);
  assert.match(crypto, /MOBILE_ACCESS_KEY_VERSION/);
});
