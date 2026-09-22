import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./dashboard.reservations.route.ts", import.meta.url),
  "utf8"
);

test("reservation detail exposes Property Protection snapshot without Stripe object IDs", () => {
  assert.match(source, /propertyProtectionRequiredSnapshot: true/);
  assert.match(source, /propertyProtectionModeSnapshot: true/);
  assert.match(source, /maxDamageLiabilityAmountSnapshot: true/);
  assert.match(source, /damagePaymentMethodStatus: true/);
  assert.match(source, /propertyProtection:\s*\{/);
  assert.match(source, /cardOnFileStatus: reservation\.damagePaymentMethodStatus/);

  const responseStart = source.indexOf("propertyProtection: {");
  const responseEnd = source.indexOf("property: reservation.property", responseStart);
  const responseBlock = source.slice(responseStart, responseEnd);
  assert.doesNotMatch(responseBlock, /stripeDamageCustomerId/);
  assert.doesNotMatch(responseBlock, /stripeDamagePaymentMethodId/);
});

test("reservation detail exposes only host-operational Damage Case fields", () => {
  assert.match(source, /damageCase:\s*reservation\.damageCase/);
  assert.match(source, /requestedAmount:/);
  assert.match(source, /approvedAmount:/);
  assert.match(source, /evidence:/);
  assert.match(source, /hostApprovedAt:/);
  assert.match(source, /guestNotifiedAt:/);
  assert.match(source, /closedReason:/);
});

test("reservation detail remains organization scoped", () => {
  assert.match(
    source,
    /id,\s*property:\s*\{\s*organizationId:\s*orgId/
  );
});
