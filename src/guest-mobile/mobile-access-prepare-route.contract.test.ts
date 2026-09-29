import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const route = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");

test("mobile eKey prepare route is default-off before auth/provider work", () => {
  const marker = '"/api/guest-mobile/stays/:reservationNumber/mobile-access/prepare"';
  const start = route.indexOf(marker);
  assert.ok(start >= 0);
  const block = route.slice(start, start + 4500);
  const flagAt = block.indexOf('MOBILE_ACCESS_EKEY_ENABLED !== "true"');
  const authAt = block.indexOf('authorization');
  const prepareAt = block.indexOf('prepareMobileAccessOnDemand');
  assert.ok(flagAt >= 0 && authAt > flagAt && prepareAt > authAt);
  assert.match(block, /status\(404\).*NOT_FOUND/s);
});

test("route uses GuestDeviceSession and minimal delivery projection", () => {
  const start = route.indexOf('"/api/guest-mobile/stays/:reservationNumber/mobile-access/prepare"');
  const block = route.slice(start, start + 4500);
  assert.match(block, /resolveGuestMobileSession/);
  assert.match(block, /readGuestMobileStay/);
  assert.match(block, /deliverMobileAccessCredential/);
  assert.match(block, /res\.json\(\{ ok: true, credential \}\)/);
});

test("reservation worker does not provision mobile eKeys", () => {
  assert.doesNotMatch(worker, /prepareMobileAccessOnDemand|TTLockMobileAccessProvider|mobile-access\/prepare/);
});


test("prepare route uses canonical stay authorization and concrete session id", () => {
  const marker = '"/api/guest-mobile/stays/:reservationNumber/mobile-access/prepare"';
  const start = route.indexOf(marker);
  assert.ok(start >= 0);
  const block = route.slice(start, start + 4500);
  assert.match(block, /authorizeGuestMobileStay/);
  assert.match(block, /guestPersonId: session\.guestPersonId/);
  assert.match(block, /guestDeviceSessionId: session\.id/);
  assert.doesNotMatch(block, /session\.sessionId/);
  assert.doesNotMatch(block, /readGuestMobileStay\(prisma, session\.guestPersonId/);
});
