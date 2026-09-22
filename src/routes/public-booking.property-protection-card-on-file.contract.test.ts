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

test("Card on File setup is gated by Property Protection", () => {
  assert.match(
    routeSource,
    /if \(propertyProtectionEnabled\) \{\s*paymentIntentData\.setup_future_usage = "off_session";\s*\}/
  );
  assert.match(routeSource, /propertyProtectionEnabled[\s\S]*customer_creation: "always"/);
});

test("unprotected Direct Booking does not unconditionally create a Customer or future-use setup", () => {
  assert.doesNotMatch(
    routeSource,
    /paymentIntentData\.setup_future_usage\s*=\s*"off_session";\s*\n\s*const APP_URL/
  );
  assert.match(routeSource, /propertyProtectionEnabled\s*\?\s*\{ customer_creation: "always" as const \}\s*:\s*\{\}/);
});

test("Card on File objects are retrieved in the connected account context", () => {
  assert.match(serviceSource, /stripe\.paymentIntents\.retrieve\([\s\S]*stripeAccount: stripeConnectedAccountId/);
  assert.match(serviceSource, /stripe\.paymentMethods\.retrieve\([\s\S]*stripeAccount: stripeConnectedAccountId/);
});

test("READY requires a Customer and card PaymentMethod", () => {
  assert.match(serviceSource, /paymentMethod\?\.type === "card"/);
  assert.match(serviceSource, /if \(customerId && reusableCardMethod\)/);
  assert.match(serviceSource, /damagePaymentMethodStatus = "READY"/);
  assert.match(serviceSource, /damagePaymentMethodStatus = "ACTION_REQUIRED"/);
  assert.match(serviceSource, /damagePaymentMethodStatus = "FAILED"/);
});

test("Card on File establishment does not create a damage charge or hold", () => {
  assert.doesNotMatch(serviceSource, /paymentIntents\.create/);
  assert.doesNotMatch(serviceSource, /capture_method/);
  assert.doesNotMatch(serviceSource, /charges\.create/);
});
