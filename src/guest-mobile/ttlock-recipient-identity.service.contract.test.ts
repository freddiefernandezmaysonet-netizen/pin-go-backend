import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./ttlock-recipient-identity.service.ts", import.meta.url), "utf8");

test("recipient username is opaque and derived only from GuestPerson id plus server salt", () => {
  assert.match(source, /TTLOCK_RECIPIENT_USERNAME_SALT/);
  assert.match(source, /guestPersonId/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.doesNotMatch(source, /guestEmail|guestPhone|reservationNumber|propertyId|guestName/);
});

test("recipient email domain is server configuration, not hardcoded personal email", () => {
  assert.match(source, /TTLOCK_RECIPIENT_EMAIL_DOMAIN/);
  assert.match(source, /guest-\$\{opaqueLocalPart\(guestPersonId\)\}/);
});

test("existing non-deleted GuestPerson identity is reused", () => {
  assert.match(source, /findUnique\(\{ where: \{ guestPersonId \} \}\)/);
  assert.match(source, /existing && existing\.status !== "DELETED"/);
  assert.match(source, /return existing/);
});

test("deleted identity may be reactivated as PENDING without exposing old provider credentials", () => {
  assert.match(source, /existing\?\.status === "DELETED"/);
  assert.match(source, /status: "PENDING"/);
  assert.match(source, /registeredAt: null/);
  assert.match(source, /deletedAt: null/);
});
