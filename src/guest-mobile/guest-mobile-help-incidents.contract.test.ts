import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const route = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");

test("Help incidents are read-only and GuestDeviceSession scoped", () => {
  const marker = '"/api/guest-mobile/stays/:reservationNumber/incidents"';
  const start = route.indexOf(marker);
  assert.ok(start >= 0);
  const handlerStart = route.lastIndexOf("guestMobileIdentityRouter.get(", start);
  assert.ok(handlerStart >= 0);
  const block = route.slice(handlerStart);
  assert.match(block, /guestMobileIdentityRouter\.get/);
  assert.match(block, /resolveGuestMobileSession/);
  assert.match(block, /resolveGuestMobilePinAIScope/);
  assert.match(block, /guestPersonId: session\.guestPersonId/);
  assert.match(block, /readPublishedIncidentUpdates/);
});

test("Help V1 does not create or mutate incidents", () => {
  assert.doesNotMatch(route, /guestMobileIdentityRouter\.post\(\s*"\/api\/guest-mobile\/stays\/:reservationNumber\/incidents"/);
  assert.doesNotMatch(route, /applyHostIncidentCommand/);
});

test("guestToken remains backend-only for incident projection", () => {
  const marker = '"/api/guest-mobile/stays/:reservationNumber/incidents"';
  const block = route.slice(route.indexOf(marker));
  assert.match(block, /guestToken: scope\.guestToken/);
  assert.doesNotMatch(block, /json\([^\n]*guestToken/);
});
