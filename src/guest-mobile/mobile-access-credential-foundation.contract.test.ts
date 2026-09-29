import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const schema = await fs.readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const crypto = await fs.readFile(new URL("./mobile-access-crypto.service.ts", import.meta.url), "utf8");
const route = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");

test("mobile credential stores encrypted lockData, never plaintext lockData", () => {
  const start = schema.indexOf("model MobileAccessCredential");
  const block = schema.slice(start, schema.indexOf("\n}", start) + 2);
  assert.match(block, /lockDataCiphertext\s+String\?/);
  assert.match(block, /lockDataKeyVersion\s+String\?/);
  assert.doesNotMatch(block, /\n\s*lockData\s+String/);
});

test("credential is bound to guest session, reservation, grant and lock", () => {
  const start = schema.indexOf("model MobileAccessCredential");
  const block = schema.slice(start, schema.indexOf("\n}", start) + 2);
  for (const field of ["guestPersonId", "guestDeviceSessionId", "reservationId", "accessGrantId", "lockId"]) assert.match(block, new RegExp(field));
  assert.match(block, /@@unique\(\[guestDeviceSessionId, accessGrantId\]\)/);
});

test("crypto uses AES-256-GCM, random IV, AAD and key versioning", () => {
  assert.match(crypto, /aes-256-gcm/);
  assert.match(crypto, /randomBytes\(12\)/);
  assert.match(crypto, /setAAD/);
  assert.match(crypto, /getAuthTag/);
  assert.match(crypto, /MOBILE_ACCESS_KEY_VERSION/);
  assert.match(crypto, /MOBILE_ACCESS_KEYS/);
});

test("foundation exposes no mobile credential or unlock endpoint", () => {
  assert.doesNotMatch(route, /mobile-access-credential|open-door|unlock/i);
});

test("foundation contains no TTLock administrative credentials", () => {
  assert.doesNotMatch(crypto, /TTLOCK_CLIENT_SECRET|TTLOCK_PASSWORD|accessToken|refreshToken/);
});
