import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(
  new URL("./public-booking.routes.ts", import.meta.url),
  "utf8"
);
const serviceSource = readFileSync(
  new URL("../services/direct-booking.service.ts", import.meta.url),
  "utf8"
);

test("create-checkout requires server-validated Property Protection consent when enabled", () => {
  assert.match(routeSource, /PROPERTY_PROTECTION_CONSENT_REQUIRED/);
  assert.match(routeSource, /PROPERTY_PROTECTION_TERMS_CHANGED/);
  assert.match(routeSource, /property\.propertyProtectionEnabled === true/);
  assert.match(routeSource, /propertyProtectionMaxDamageLiabilityAmount/);
});

test("Property Protection consent terms come from server property configuration", () => {
  assert.match(routeSource, /property\.maxDamageLiabilityAmount/);
  assert.match(routeSource, /property_protection_card_on_file_v1/);
  assert.match(routeSource, /guestAcceptedPropertyProtectionMaxDamageLiabilityAmount/);
});

test("checkout metadata carries Property Protection evidence without changing Stripe payment setup", () => {
  assert.match(routeSource, /propertyProtectionConsentAcceptedAt/);
  assert.doesNotMatch(routeSource, /setup_future_usage/);
  assert.doesNotMatch(routeSource, /customer_creation/);
});

test("completed checkout persists immutable Property Protection snapshot and consent", () => {
  assert.match(serviceSource, /propertyProtectionRequiredSnapshot/);
  assert.match(serviceSource, /propertyProtectionModeSnapshot/);
  assert.match(serviceSource, /maxDamageLiabilityAmountSnapshot/);
  assert.match(serviceSource, /propertyProtectionPolicySnapshot/);
  assert.match(serviceSource, /damagePaymentConsent/);
  assert.match(serviceSource, /SETUP_PENDING/);
  assert.match(serviceSource, /DIRECT_BOOKING_PROPERTY_PROTECTION_CONSENT_INVALID/);
});

test("disabled Property Protection remains NOT_REQUIRED", () => {
  assert.match(
    serviceSource,
    /propertyProtectionRequired\s*\?\s*"SETUP_PENDING"\s*:\s*"NOT_REQUIRED"/
  );
});
