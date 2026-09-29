import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-delivery.service.ts", import.meta.url), "utf8");

test("delivery is bound to exact GuestDeviceSession, ACTIVE state and live window", () => {
  assert.match(source, /guestDeviceSessionId: input\.guestDeviceSessionId/);
  assert.match(source, /status: "ACTIVE"/);
  assert.match(source, /startsAt: \{ lte: now \}/);
  assert.match(source, /endsAt: \{ gt: now \}/);
});

test("lockData is decrypted only for minimal delivery projection", () => {
  assert.match(source, /decryptMobileLockData/);
  assert.match(source, /lastDeliveredAt: now/);
  assert.match(source, /lockData,/);
  assert.match(source, /lockMac: credential\.lockMac/);
});

test("delivery response excludes provider and TTLock account credentials", () => {
  const returnAt = source.lastIndexOf("return {");
  const response = source.slice(returnAt);
  assert.doesNotMatch(response, /providerKeyId|providerUid|username|accessToken|refreshToken|password|ttlockLockId/i);
  assert.doesNotMatch(response, /accessGrantId|lockId/);
});
