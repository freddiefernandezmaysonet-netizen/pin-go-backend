import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(
  new URL("../services/guest-cancellation.service.ts", import.meta.url),
  "utf8"
);
const routeSource = readFileSync(
  new URL("./public-booking.routes.ts", import.meta.url),
  "utf8"
);

test("Manage Reservation exposes Damage Case only after host approval", () => {
  assert.match(serviceSource, /GUEST_NOTIFICATION_PENDING/);
  assert.match(serviceSource, /GUEST_NOTIFIED/);
  assert.match(serviceSource, /CHARGE_BLOCKED/);
  assert.match(serviceSource, /CLOSED_NO_CHARGE/);
  assert.match(
    serviceSource,
    /damageCase\?\.status === "CLOSED_NO_CHARGE"[\s\S]*Boolean\(damageCase\.hostApprovedAt\)/
  );
  assert.doesNotMatch(
    serviceSource.slice(
      serviceSource.indexOf("getGuestPropertyProtectionCase"),
      serviceSource.indexOf("getGuestCancellationPreview")
    ),
    /"OPEN"|"EVIDENCE_PENDING"|"HOST_REVIEW"/
  );
});

test("guest portal case uses immutable reservation protection snapshot", () => {
  assert.match(serviceSource, /propertyProtectionRequiredSnapshot/);
  assert.match(serviceSource, /propertyProtectionModeSnapshot/);
  assert.match(serviceSource, /maxDamageLiabilityAmountSnapshot/);
  assert.match(serviceSource, /requestedAmount/);
  assert.match(serviceSource, /approvedAmount/);
  assert.match(serviceSource, /evidenceNotes/);
});

test("guest-facing payload explicitly reports no collection in this phase", () => {
  assert.match(serviceSource, /collectionStatus:/);
  assert.match(serviceSource, /"NO_CHARGE_MADE"/);
  assert.match(serviceSource, /"CLOSED_NO_CHARGE"/);
  assert.doesNotMatch(serviceSource, /stripeDamageCustomerId/);
  assert.doesNotMatch(serviceSource, /stripeDamagePaymentMethodId/);
});

test("Property Protection case endpoint reuses guestToken and is no-store", () => {
  assert.match(routeSource, /\/manage\/:guestToken\/property-protection-case/);
  assert.match(routeSource, /getGuestPropertyProtectionCase/);
  assert.match(routeSource, /Cache-Control", "no-store"/);
});

test("guest portal Property Protection endpoint contains no financial mutation", () => {
  const start = routeSource.indexOf('"/manage/:guestToken/property-protection-case"');
  const end = routeSource.indexOf('"/manage/:guestToken/cancellation-preview"', start);
  const block = routeSource.slice(start, end);
  assert.doesNotMatch(block, /paymentIntents/);
  assert.doesNotMatch(block, /charges\./);
  assert.doesNotMatch(block, /refunds\./);
});


test("a case closed before host approval remains private", () => {
  const block = serviceSource.slice(
    serviceSource.indexOf("getGuestPropertyProtectionCase"),
    serviceSource.indexOf("getGuestCancellationPreview")
  );
  assert.match(block, /guestVisibleDamageCase/);
  assert.match(block, /hostApprovedAt/);
});
