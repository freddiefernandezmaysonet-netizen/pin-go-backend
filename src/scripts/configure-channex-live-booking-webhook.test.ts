import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeChannexLiveBaseUrl,
  normalizeChannexLiveWebhookCallbackUrl,
} from "./configure-channex-live-booking-webhook";

test("normalizeChannexLiveBaseUrl allows live Channex HTTPS hosts", () => {
  assert.equal(
    normalizeChannexLiveBaseUrl("https://app.channex.io/"),
    "https://app.channex.io"
  );
  assert.equal(
    normalizeChannexLiveBaseUrl("https://api.channex.io"),
    "https://api.channex.io"
  );
});

test("normalizeChannexLiveBaseUrl rejects staging and non-Channex hosts", () => {
  assert.throws(
    () => normalizeChannexLiveBaseUrl("https://staging.channex.io"),
    /CHANNEX_LIVE_WEBHOOK_REJECTS_STAGING/
  );
  assert.throws(
    () => normalizeChannexLiveBaseUrl("https://example.com"),
    /CHANNEX_LIVE_WEBHOOK_REQUIRES_CHANNEX_HOST/
  );
  assert.throws(
    () => normalizeChannexLiveBaseUrl("http://app.channex.io"),
    /CHANNEX_LIVE_WEBHOOK_REQUIRES_HTTPS/
  );
});

test("normalizeChannexLiveWebhookCallbackUrl requires production webhook callback", () => {
  assert.equal(
    normalizeChannexLiveWebhookCallbackUrl(
      "https://api.pin-ngo.com/webhooks/channex"
    ),
    "https://api.pin-ngo.com/webhooks/channex"
  );

  assert.throws(
    () =>
      normalizeChannexLiveWebhookCallbackUrl(
        "https://api.pin-ngo.com/webhooks/not-channex"
      ),
    /CHANNEX_WEBHOOK_CALLBACK_PATH_INVALID/
  );
  assert.throws(
    () =>
      normalizeChannexLiveWebhookCallbackUrl(
        "https://staging.pin-ngo.com/webhooks/channex"
      ),
    /CHANNEX_LIVE_WEBHOOK_CALLBACK_MUST_BE_PRODUCTION_API/
  );
});
