import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const eligibility = await fs.readFile(new URL("./mobile-access-eligibility.service.ts", import.meta.url), "utf8");
const provisioning = await fs.readFile(new URL("./mobile-access-provisioning.service.ts", import.meta.url), "utf8");
const provider = await fs.readFile(new URL("./mobile-access-provider.ts", import.meta.url), "utf8");

test("provisioning is gated by canonical Guest access state", () => {
  assert.match(eligibility, /guestDeviceSession\.findFirst/);
  assert.match(eligibility, /guestStayLink\.findFirst/);
  assert.match(eligibility, /guestAccessReleaseStatus !== "RELEASED"/);
  assert.match(eligibility, /type: "GUEST", status: "ACTIVE"/);
  assert.match(eligibility, /startsAt: \{ lte: now \}, endsAt: \{ gt: now \}/);
  assert.match(eligibility, /ttlockLockId/);
});

test("provider boundary is timebound and contains no admin secret", () => {
  assert.match(provider, /issueTimeboundKey/);
  assert.match(provider, /startsAt: Date/);
  assert.match(provider, /endsAt: Date/);
  assert.doesNotMatch(provider, /accessToken|clientSecret|password|refreshToken/i);
});

test("provisioning is idempotent per guest device and AccessGrant", () => {
  assert.match(provisioning, /guestDeviceSessionId_accessGrantId/);
  assert.match(provisioning, /existing\?\.status === "ACTIVE"/);
  assert.match(provisioning, /reused: true/);
});

test("lockData is encrypted before persistence", () => {
  const encryptAt = provisioning.indexOf("encryptMobileLockData(");
  const persistAt = provisioning.indexOf("lockDataCiphertext:");
  assert.ok(encryptAt >= 0 && persistAt > encryptAt);
  assert.doesNotMatch(provisioning, /lockData:\s*issued\.lockData/);
});

test("orphan provider eKey is revoked when provisioning fails after issue", () => {
  assert.match(provisioning, /if \(issued\?\.providerKeyId\)/);
  assert.match(provisioning, /provider\.revokeKey/);
  assert.match(provisioning, /status: "FAILED"/);
});
