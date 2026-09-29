import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./guest-mobile-session.service.ts", import.meta.url), "utf8");

test("guest mobile bearer is random and only its SHA-256 hash is persisted", () => {
  assert.match(source, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /tokenHash: hashToken\(bearer\)/);
  assert.doesNotMatch(source, /data:\s*\{[^}]*bearer,/s);
});

test("exchange rejects expired stay tokens and revoked stay links", () => {
  assert.match(source, /guestTokenExpiresAt: \{ gt: now \}/);
  assert.match(source, /GUEST_MOBILE_STAY_LINK_REVOKED/);
});

test("an existing stay link is reused instead of silently relinking reservation", () => {
  assert.match(source, /if \(reservation\.guestStayLink\)/);
  assert.match(source, /guestPersonId = reservation\.guestStayLink\.guestPersonId/);
  assert.match(source, /reservationId: reservation\.id/);
});

test("mobile session authorization remains person-scoped", () => {
  const start = source.indexOf("export async function resolveGuestMobileSession");
  const end = source.indexOf("export async function authorizeGuestMobileStay", start);
  const block = source.slice(start, end);
  assert.match(block, /guestPersonId/);
  assert.doesNotMatch(block, /organizationId/);
  assert.doesNotMatch(block, /propertyId/);
});
