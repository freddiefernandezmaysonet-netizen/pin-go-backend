import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateChannexStagingReadiness,
  type ChannexStagingReadinessInput,
} from "./channex-staging-readiness.policy";

function readyInput(): ChannexStagingReadinessInput {
  return {
    nodeEnv: "staging",
    databaseConfigured: true,
    apiBaseUrl: "https://staging.channex.io",
    callbackUrl: "https://pin-go-api-staging.example.com/webhooks/channex",
    propertyId: "property-staging-001",
    propertyFound: true,
    propertyStatus: "ACTIVE",
    connectionCount: 1,
    connectionStatus: "ACTIVE",
    webhookSecretPresent: true,
    listings: [
      {
        externalListingId: "room-type-001",
        channexPropertyId: "channex-property-001",
        webhookId: "webhook-001",
        webhookCallbackUrl:
          "https://pin-go-api-staging.example.com/webhooks/channex",
        webhookEventMask: "booking",
        webhookSendData: false,
        webhookConfiguredAt: "2026-07-25T00:00:00.000Z",
      },
      {
        externalListingId: "room-type-002",
        channexPropertyId: "channex-property-001",
        webhookId: "webhook-001",
        webhookCallbackUrl:
          "https://pin-go-api-staging.example.com/webhooks/channex",
        webhookEventMask: "booking",
        webhookSendData: false,
        webhookConfiguredAt: "2026-07-25T00:00:00.000Z",
      },
    ],
    worker: {
      pollMs: 5_000,
      batchSize: 20,
      maxAttempts: 8,
      pendingMinAgeMs: 0,
      retryDelayMs: 30_000,
      staleProcessingMs: 600_000,
    },
  };
}

test("complete staging configuration is ready", () => {
  const result = evaluateChannexStagingReadiness(readyInput());

  assert.equal(result.ready, true);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.passed, result.summary.total);
});

test("production callback is blocked", () => {
  const input = readyInput();
  input.callbackUrl = "https://api.pin-ngo.com/webhooks/channex";
  input.listings = input.listings.map((listing) => ({
    ...listing,
    webhookCallbackUrl: input.callbackUrl,
  }));

  const result = evaluateChannexStagingReadiness(input);
  const check = result.checks.find(
    (item) => item.code === "CALLBACK_IS_SAFE_STAGING_HTTPS"
  );

  assert.equal(result.ready, false);
  assert.equal(check?.status, "FAIL");
});

test("missing secret and webhook registration block readiness", () => {
  const input = readyInput();
  input.webhookSecretPresent = false;
  input.listings = input.listings.map((listing) => ({
    ...listing,
    webhookId: null,
    webhookConfiguredAt: null,
  }));

  const result = evaluateChannexStagingReadiness(input);

  assert.equal(result.ready, false);
  assert.equal(
    result.checks.find((item) => item.code === "WEBHOOK_SECRET_CONFIGURED")
      ?.status,
    "FAIL"
  );
  assert.equal(
    result.checks.find(
      (item) => item.code === "WEBHOOK_REGISTRATION_METADATA_PRESENT"
    )?.status,
    "FAIL"
  );
});

test("multiple Channex property IDs fail readiness", () => {
  const input = readyInput();
  input.listings[1] = {
    ...input.listings[1]!,
    channexPropertyId: "channex-property-002",
  };

  const result = evaluateChannexStagingReadiness(input);

  assert.equal(result.ready, false);
  assert.equal(
    result.checks.find(
      (item) => item.code === "SINGLE_CHANNEX_PROPERTY_MAPPING"
    )?.status,
    "FAIL"
  );
});

test("unsafe worker values fail readiness", () => {
  const input = readyInput();
  input.worker = {
    pollMs: 0,
    batchSize: 500,
    maxAttempts: 0,
    pendingMinAgeMs: -1,
    retryDelayMs: 0,
    staleProcessingMs: 1_000,
  };

  const result = evaluateChannexStagingReadiness(input);

  assert.equal(result.ready, false);
  assert.equal(
    result.checks.filter((item) => item.code.startsWith("WORKER_") && item.status === "FAIL")
      .length,
    6
  );
});
