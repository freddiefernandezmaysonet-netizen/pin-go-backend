import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const schema = await fs.readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const retention = await fs.readFile(new URL("./ttlock-recipient-retention.service.ts", import.meta.url), "utf8");
const registration = await fs.readFile(new URL("./ttlock-recipient-provider.service.ts", import.meta.url), "utf8");
const provisioning = await fs.readFile(new URL("./mobile-access-provisioning.service.ts", import.meta.url), "utf8");

test("recipient retention defaults to one year with bounded configuration", () => {
  assert.match(retention, /TTLOCK_RECIPIENT_RETENTION_DAYS \?\? 365/);
  assert.match(retention, /value >= 180 && value <= 730/);
});

test("retention blocks deletion for active credentials or active/future stays", () => {
  assert.match(retention, /mobileAccessCredential\.count/);
  assert.match(retention, /guestStayLink\.count/);
  assert.match(retention, /ACTIVE_MOBILE_CREDENTIALS/);
  assert.match(retention, /FUTURE_OR_ACTIVE_STAY/);
  assert.match(retention, /DELETE_PENDING/);
});

test("deleted identity becomes credential-free audit tombstone", () => {
  assert.match(retention, /status: "DELETED"/);
  for (const field of ["passwordCiphertext", "passwordKeyVersion", "accessTokenCiphertext", "refreshTokenCiphertext", "tokenKeyVersion", "tokenExpiresAt"]) {
    assert.match(retention, new RegExp(field + ": null"));
  }
  const start = schema.indexOf("model TTLockRecipientIdentity");
  const block = schema.slice(start, schema.indexOf("\n}", start) + 2);
  assert.match(block, /passwordCiphertext\s+String\?/);
  assert.match(block, /lastActivityAt\s+DateTime\?/);
});

test("registration and successful eKey provisioning refresh global guest activity", () => {
  assert.match(registration, /lastActivityAt: new Date\(\)/);
  assert.match(provisioning, /tTLockRecipientIdentity\.updateMany/);
  assert.match(provisioning, /lastActivityAt: input\.now \?\? new Date\(\)/);
});
