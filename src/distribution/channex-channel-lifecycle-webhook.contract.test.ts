import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK } from "./channex-channel-lifecycle.evidence.js";
import {
  ChannexChannelLifecycleWebhookContractError,
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_PATH,
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER,
  buildChannexChannelLifecycleWebhookPayload,
  hasCompleteOtaChannelLifecycleEventMask,
  normalizeOtaChannelLifecycleWebhookCallbackUrl,
  parseOtaChannelLifecycleEventMask,
} from "./channex-channel-lifecycle-webhook.contract.js";

const callbackUrl =
  "https://api-staging.example.com/webhooks/ota/channex/channel-lifecycle";
const externalPropertyId = "faf0559d-965f-426c-8303-107b0b1bc5ff";

test("registration contract consumes the canonical six-event lifecycle mask", () => {
  assert.equal(
    OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
    CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK
  );
  assert.equal(
    OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK,
    "new_channel;updated_channel;activate_channel;deactivate_channel;disconnect_channel;disconnect_listing"
  );
});

test("lifecycle payload is property scoped, authenticated and includes data", () => {
  assert.deepEqual(
    buildChannexChannelLifecycleWebhookPayload({
      externalPropertyId,
      callbackUrl,
      webhookSecret: "secret-value",
    }),
    {
      webhook: {
        property_id: externalPropertyId,
        callback_url: callbackUrl,
        event_mask: CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK,
        headers: {
          [OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER]: "secret-value",
        },
        is_active: true,
        send_data: true,
      },
    }
  );
  assert.notEqual(
    OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER,
    "x-pin-go-webhook-secret"
  );
});

test("lifecycle payload rejects non-UUID Channex property identifiers", () => {
  assert.throws(
    () =>
      buildChannexChannelLifecycleWebhookPayload({
        externalPropertyId: "property-ext-1",
        callbackUrl,
        webhookSecret: "secret-value",
      }),
    (error: unknown) =>
      error instanceof ChannexChannelLifecycleWebhookContractError &&
      error.code === "OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID_REQUIRED"
  );
});

test("callback validation accepts only the dedicated HTTPS lifecycle path", () => {
  assert.equal(OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_PATH, new URL(callbackUrl).pathname);
  assert.equal(normalizeOtaChannelLifecycleWebhookCallbackUrl(callbackUrl), callbackUrl);

  for (const invalid of [
    "http://api-staging.example.com/webhooks/ota/channex/channel-lifecycle",
    "https://api-staging.example.com/webhooks/channex",
    `${callbackUrl}?test=true`,
    `${callbackUrl}#fragment`,
  ]) {
    assert.throws(
      () => normalizeOtaChannelLifecycleWebhookCallbackUrl(invalid),
      (error: unknown) =>
        error instanceof ChannexChannelLifecycleWebhookContractError &&
        error.code === "OTA_CHANNEL_LIFECYCLE_WEBHOOK_CALLBACK_INVALID"
    );
  }
});

test("event masks compare as sets while wildcard, duplicates and mixed masks fail closed", () => {
  assert.equal(
    hasCompleteOtaChannelLifecycleEventMask(
      "disconnect_listing;activate_channel;new_channel;disconnect_channel;updated_channel;deactivate_channel"
    ),
    true
  );
  assert.equal(hasCompleteOtaChannelLifecycleEventMask("updated_channel"), false);

  assert.throws(
    () => parseOtaChannelLifecycleEventMask("*"),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_WILDCARD_FORBIDDEN/
  );
  assert.throws(
    () => parseOtaChannelLifecycleEventMask("updated_channel;booking"),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_MIXED/
  );
  assert.throws(
    () => parseOtaChannelLifecycleEventMask("updated_channel;updated_channel"),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_EVENT_MASK_INVALID/
  );
});
