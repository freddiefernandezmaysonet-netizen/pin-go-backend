import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("./mobile-access-on-demand.service.ts", import.meta.url), "utf8");
const routes = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");

test("on-demand flow requires valid GuestDeviceSession and linked stay", () => {
  assert.match(source, /guestDeviceSession\.findFirst/);
  assert.match(source, /revokedAt: null/);
  assert.match(source, /expiresAt: \{ gt: new Date\(\) \}/);
  assert.match(source, /guestStayLink\.findFirst/);
  assert.match(source, /reservationId: input\.reservationId/);
});

test("on-demand flow reuses or activates one global recipient identity", () => {
  assert.match(source, /resolveOrCreateTTLockRecipientIdentity/);
  assert.match(source, /identity\.status !== "ACTIVE"/);
  assert.match(source, /registerAndAuthenticateTTLockRecipient/);
  assert.match(source, /TTLOCK_RECIPIENT_NOT_ACTIVE/);
});

test("provider is organization-scoped and issuance remains canonical", () => {
  assert.match(source, /organizationId: stay\.reservation\.property\.organizationId/);
  assert.match(source, /recipientIdentityId: identity\.id/);
  assert.match(source, /issueMobileAccessForGuestSession/);
});

test("on-demand composition is not yet exposed over HTTP", () => {
  assert.doesNotMatch(routes, /prepareMobileAccessOnDemand/);
});
