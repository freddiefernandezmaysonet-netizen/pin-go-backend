import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(
  new URL("./public-booking.routes.ts", import.meta.url),
  "utf8"
);
const serviceSource = readFileSync(
  new URL("../services/guest-damage-case-portal.service.ts", import.meta.url),
  "utf8"
);

test("Manage Reservation exposes Damage Case as read-only GET", () => {
  assert.match(
    routeSource,
    /publicBookingRouter\.get\(\s*"\/manage\/:guestToken\/damage-case"/
  );
  assert.doesNotMatch(
    routeSource,
    /publicBookingRouter\.post\(\s*"\/manage\/:guestToken\/damage-case"/
  );
  assert.match(routeSource, /Cache-Control", "no-store"/);
});

test("guest Damage Case service never imports or mutates Stripe", () => {
  assert.doesNotMatch(serviceSource, /billing\/stripe/);
  assert.doesNotMatch(serviceSource, /paymentIntents|charges\.|refunds\.|capture_method/);
  assert.match(serviceSource, /chargeExecuted: false/);
});

test("guest portal hides pre-approval Damage Case states", () => {
  assert.match(serviceSource, /GUEST_NOTIFICATION_PENDING/);
  assert.match(serviceSource, /GUEST_NOTIFIED/);
  assert.match(serviceSource, /CHARGE_BLOCKED/);
  const visibleList = serviceSource.slice(
    serviceSource.indexOf("GUEST_VISIBLE_DAMAGE_CASE_STATUSES"),
    serviceSource.indexOf("] as const")
  );
  assert.doesNotMatch(visibleList, /HOST_REVIEW|EVIDENCE_PENDING|OPEN/);
});
