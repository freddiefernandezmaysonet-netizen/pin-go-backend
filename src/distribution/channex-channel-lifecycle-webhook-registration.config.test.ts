import assert from "node:assert/strict";
import test from "node:test";

import {
  OTA_CHANNEL_LIFECYCLE_REGISTRATION_APPLY_CONFIRMATION,
  buildOtaChannelLifecycleRegistrationApplyConfirmation,
  resolveOtaChannelLifecycleWebhookRegistrationConfig,
} from "./channex-channel-lifecycle-webhook-registration.config.js";

const externalPropertyId = "faf0559d-965f-426c-8303-107b0b1bc5ff";
const otherPropertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const callbackOrigin = "https://api-staging.example.com";
const callbackUrl =
  `${callbackOrigin}/webhooks/ota/channex/channel-lifecycle`;
const complete = {
  OTA_CHANNEL_LIFECYCLE_REGISTRATION_ENABLED: "true",
  OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://staging.channex.io",
  OTA_CONNECTION_API_KEY: "api-key",
  OTA_CHANNEL_LIFECYCLE_CALLBACK_URL: callbackUrl,
  OTA_CHANNEL_LIFECYCLE_CALLBACK_ALLOWED_ORIGIN: callbackOrigin,
  OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID: externalPropertyId,
  OTA_CHANNEL_WEBHOOK_SECRET: "webhook-secret",
};

test("registration is disabled and PLAN by default without retaining secrets", () => {
  const result = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    OTA_CONNECTION_API_KEY: "must-not-be-returned",
    OTA_CHANNEL_WEBHOOK_SECRET: "must-not-be-returned-either",
  });
  assert.deepEqual(result, {
    enabled: false,
    mode: "PLAN",
    reason: "DEFAULT_OFF",
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-be-returned/);
});

test("enabled registration defaults to read-only PLAN mode", () => {
  const result = resolveOtaChannelLifecycleWebhookRegistrationConfig(complete);
  assert.equal(result.enabled, true);
  if (!result.enabled) return;
  assert.equal(result.mode, "PLAN");
  assert.equal(result.apiOrigin, "https://staging.channex.io");
  assert.equal(result.timeoutMs, 10_000);
});

test("registration is staging-only even in PLAN mode", () => {
  const result = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    ...complete,
    OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io",
  });
  assert.deepEqual(result, {
    enabled: false,
    mode: "PLAN",
    reason: "STAGING_REQUIRED",
  });
});

test("APPLY requires staging and confirmation bound to property and callback", () => {
  const missingConfirmation =
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "APPLY",
    });
  assert.deepEqual(missingConfirmation, {
    enabled: false,
    mode: "APPLY",
    reason: "APPLY_CONFIRMATION_REQUIRED",
  });

  const live = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    ...complete,
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "APPLY",
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION:
      buildOtaChannelLifecycleRegistrationApplyConfirmation(
        externalPropertyId,
        callbackUrl
      ),
    OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io",
  });
  assert.deepEqual(live, {
    enabled: false,
    mode: "APPLY",
    reason: "STAGING_REQUIRED",
  });

  const unbound = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    ...complete,
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "APPLY",
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION:
      OTA_CHANNEL_LIFECYCLE_REGISTRATION_APPLY_CONFIRMATION,
  });
  assert.deepEqual(unbound, {
    enabled: false,
    mode: "APPLY",
    reason: "APPLY_CONFIRMATION_REQUIRED",
  });

  const wrongProperty = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    ...complete,
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "APPLY",
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION:
      buildOtaChannelLifecycleRegistrationApplyConfirmation(
        otherPropertyId,
        callbackUrl
      ),
  });
  assert.deepEqual(wrongProperty, {
    enabled: false,
    mode: "APPLY",
    reason: "APPLY_CONFIRMATION_REQUIRED",
  });

  const staging = resolveOtaChannelLifecycleWebhookRegistrationConfig({
    ...complete,
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "APPLY",
    OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION:
      buildOtaChannelLifecycleRegistrationApplyConfirmation(
        externalPropertyId,
        callbackUrl
      ),
  });
  assert.equal(staging.enabled, true);
  if (!staging.enabled) return;
  assert.equal(staging.mode, "APPLY");
  if (staging.mode !== "APPLY") return;
  assert.equal(
    staging.applyConfirmation,
    buildOtaChannelLifecycleRegistrationApplyConfirmation(
      externalPropertyId,
      callbackUrl
    )
  );
});

test("callback origin is explicitly allowlisted and APPLY confirmation cannot be reused after drift", () => {
  const driftedCallbackUrl =
    "https://attacker.example/webhooks/ota/channex/channel-lifecycle";
  assert.deepEqual(
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_LIFECYCLE_CALLBACK_URL: driftedCallbackUrl,
    }),
    {
      enabled: false,
      mode: "PLAN",
      reason: "CALLBACK_ORIGIN_NOT_ALLOWED",
    }
  );

  const staleConfirmation =
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "APPLY",
      OTA_CHANNEL_LIFECYCLE_CALLBACK_URL: driftedCallbackUrl,
      OTA_CHANNEL_LIFECYCLE_CALLBACK_ALLOWED_ORIGIN:
        "https://attacker.example",
      OTA_CHANNEL_LIFECYCLE_REGISTRATION_CONFIRMATION:
        buildOtaChannelLifecycleRegistrationApplyConfirmation(
          externalPropertyId,
          callbackUrl
        ),
    });
  assert.deepEqual(staleConfirmation, {
    enabled: false,
    mode: "APPLY",
    reason: "APPLY_CONFIRMATION_REQUIRED",
  });
});

test("invalid enable, mode and incomplete configuration remain disabled", () => {
  assert.deepEqual(
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_LIFECYCLE_REGISTRATION_ENABLED: "yes",
    }),
    { enabled: false, mode: "PLAN", reason: "INVALID_ENABLED_VALUE" }
  );
  assert.deepEqual(
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_LIFECYCLE_REGISTRATION_MODE: "UPDATE",
    }),
    { enabled: false, mode: "PLAN", reason: "INVALID_MODE" }
  );
  assert.deepEqual(
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_WEBHOOK_SECRET: "",
    }),
    { enabled: false, mode: "PLAN", reason: "CONFIGURATION_INCOMPLETE" }
  );
  assert.deepEqual(
    resolveOtaChannelLifecycleWebhookRegistrationConfig({
      ...complete,
      OTA_CHANNEL_LIFECYCLE_EXTERNAL_PROPERTY_ID: "property-ext-1",
    }),
    { enabled: false, mode: "PLAN", reason: "CONFIGURATION_INCOMPLETE" }
  );
});
