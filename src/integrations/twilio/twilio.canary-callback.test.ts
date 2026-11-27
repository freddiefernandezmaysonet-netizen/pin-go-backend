import assert from "node:assert/strict";
import test from "node:test";
import { resolveTwilioStatusCallback } from "./twilio.client";

test("scoped SMS receipt requires an exact enabled canary, leaving global behavior intact", () => {
  const scope = { organizationId: "lab-org", propertyId: "lab-property", reservationId: "lab-reservation" };
  const recipient = "+15005550001";
  const env = {
    NODE_ENV: "production", API_BASE_URL: "https://lab.invalid", TWILIO_AUTH_TOKEN: "test-only",
    GUEST_JOURNEY_CANARY_EXECUTE: "1", GUEST_JOURNEY_CANARY_SMS_CALLBACK_ENABLED: "1",
    GUEST_JOURNEY_CANARY_ORGANIZATION_ID: scope.organizationId,
    GUEST_JOURNEY_CANARY_PROPERTY_ID: scope.propertyId,
    GUEST_JOURNEY_CANARY_RESERVATION_ID: scope.reservationId, GUEST_JOURNEY_CANARY_SMS: recipient,
  };
  const callback = "https://lab.invalid/webhooks/delivery/twilio";
  assert.equal(resolveTwilioStatusCallback(env, scope, recipient), callback);
  assert.equal(resolveTwilioStatusCallback(env), null);
  for (const key of Object.keys(scope)) {
    assert.equal(resolveTwilioStatusCallback(env, { ...scope, [key]: "other" }, recipient), null);
  }
  assert.equal(resolveTwilioStatusCallback(env, scope, "+15005550002"), null);
  for (const key of ["GUEST_JOURNEY_CANARY_EXECUTE", "GUEST_JOURNEY_CANARY_SMS_CALLBACK_ENABLED", "TWILIO_AUTH_TOKEN"]) {
    assert.equal(resolveTwilioStatusCallback({ ...env, [key]: "" }, scope, recipient), null);
  }
  assert.equal(resolveTwilioStatusCallback({ ...env, MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1" }), callback);
});
