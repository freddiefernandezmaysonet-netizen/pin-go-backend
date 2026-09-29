import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const issuance = await fs.readFile(new URL("./mobile-access-issuance.service.ts", import.meta.url), "utf8");
const routes = await fs.readFile(new URL("../routes/guest-mobile-identity.routes.ts", import.meta.url), "utf8");
const worker = await fs.readFile(new URL("../workers/reservation.worker.ts", import.meta.url), "utf8");

test("issuance requires explicit GuestDeviceSession, reservation and recipient identity", () => {
  assert.match(issuance, /guestDeviceSessionId/);
  assert.match(issuance, /reservationId/);
  assert.match(issuance, /recipient/);
  assert.match(issuance, /MOBILE_ACCESS_ISSUANCE_INPUT_INVALID/);
});

test("issuance delegates to canonical provisioning eligibility and idempotency", () => {
  assert.match(issuance, /provisionMobileAccessCredential/);
  assert.match(issuance, /guestDeviceSessionId: input\.guestDeviceSessionId/);
  assert.match(issuance, /reservationId: input\.reservationId/);
});

test("issuance remains disconnected from routes and reservation worker", () => {
  assert.doesNotMatch(routes, /issueMobileAccessForGuestSession/);
  assert.doesNotMatch(worker, /issueMobileAccessForGuestSession/);
});
