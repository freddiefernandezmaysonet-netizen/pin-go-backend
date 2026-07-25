import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChannexBookingWebhookPayload,
  normalizeChannexStagingBaseUrl,
  normalizeChannexWebhookCallbackUrl,
} from "./channex-booking-webhook-registration.service";

test("registration accepts only the official Channex staging host", () => {
  assert.equal(
    normalizeChannexStagingBaseUrl(
      "https://staging.channex.io/"
    ),
    "https://staging.channex.io"
  );

  assert.throws(
    () =>
      normalizeChannexStagingBaseUrl(
        "https://app.channex.io"
      ),
    /CHANNEX_WEBHOOK_REGISTRATION_REQUIRES_STAGING/
  );

  assert.throws(
    () =>
      normalizeChannexStagingBaseUrl(
        "http://staging.channex.io"
      ),
    /CHANNEX_WEBHOOK_REGISTRATION_REQUIRES_STAGING/
  );
});

test("callback must be HTTPS and target the global Channex route", () => {
  assert.equal(
    normalizeChannexWebhookCallbackUrl(
      "https://api.example.com/webhooks/channex"
    ),
    "https://api.example.com/webhooks/channex"
  );

  assert.throws(
    () =>
      normalizeChannexWebhookCallbackUrl(
        "http://api.example.com/webhooks/channex"
      ),
    /CHANNEX_WEBHOOK_CALLBACK_REQUIRES_HTTPS/
  );

  assert.throws(
    () =>
      normalizeChannexWebhookCallbackUrl(
        "https://api.example.com/webhooks/other"
      ),
    /CHANNEX_WEBHOOK_CALLBACK_PATH_INVALID/
  );
});

test("booking webhook payload is pull-trigger only and authenticated", () => {
  const payload = buildChannexBookingWebhookPayload({
    channexPropertyId: "property-001",
    callbackUrl:
      "https://api.example.com/webhooks/channex",
    webhookSecret: "secret-value",
  });

  assert.deepEqual(payload, {
    webhook: {
      property_id: "property-001",
      callback_url:
        "https://api.example.com/webhooks/channex",
      event_mask: "booking",
      headers: {
        "x-pin-go-webhook-secret": "secret-value",
      },
      is_active: true,
      send_data: false,
    },
  });
});
