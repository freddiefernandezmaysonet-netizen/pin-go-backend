import assert from "node:assert/strict";
import test from "node:test";

import {
  OTA_CHANNEL_WEBHOOK_SECRET_HEADER,
  processChannexChannelLifecycleWebhook,
  verifyOtaChannelWebhookSecret,
} from "./channex-channel-lifecycle.webhook.route.js";
import { ChannexChannelEvidenceError } from "../distribution/channex-channel-lifecycle.evidence.js";

const headers = { [OTA_CHANNEL_WEBHOOK_SECRET_HEADER]: "secret-1" };

test("channel lifecycle webhook is default-off", async () => {
  let called = false;
  const result = await processChannexChannelLifecycleWebhook({
    enabled: false,
    expectedSecret: "secret-1",
    headers,
    body: {},
    async applyEvidence() { called = true; return { ignored: false }; },
  });
  assert.equal(result.status, 503);
  assert.equal(called, false);
});

test("webhook secret comparison accepts exact dedicated secret", () => {
  assert.equal(verifyOtaChannelWebhookSecret({ expectedSecret: "secret-1", headers }), true);
});

test("webhook secret comparison rejects missing or different secret", () => {
  assert.equal(verifyOtaChannelWebhookSecret({ expectedSecret: "secret-1", headers: {} }), false);
  assert.equal(verifyOtaChannelWebhookSecret({
    expectedSecret: "secret-1",
    headers: { [OTA_CHANNEL_WEBHOOK_SECRET_HEADER]: "secret-2" },
  }), false);
});

test("invalid authentication never reaches evidence layer", async () => {
  let called = false;
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers: {},
    body: {},
    async applyEvidence() { called = true; return { ignored: false }; },
  });
  assert.equal(result.status, 401);
  assert.equal(called, false);
});

test("unsupported lifecycle event is acknowledged but ignored", async () => {
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers,
    body: {},
    async applyEvidence() { return { ignored: true, ignoredReason: "UNSUPPORTED_EVENT" }; },
  });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { ok: true, ignored: true, reason: "UNSUPPORTED_EVENT" });
});

test("deduplicated lifecycle evidence is acknowledged without replaying state", async () => {
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers,
    body: {},
    async applyEvidence() {
      return {
        ignored: true,
        ignoredReason: "DUPLICATE_LIFECYCLE_EVENT",
        deduped: true,
        connectionId: "conn-1",
        eventType: "activate_channel",
      };
    },
  });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, {
    ok: true,
    ignored: true,
    reason: "DUPLICATE_LIFECYCLE_EVENT",
  });
});

test("accepted evidence returns no provider credential or payload", async () => {
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers,
    body: { secret: "must-not-echo" },
    async applyEvidence() {
      return { ignored: false, deduped: false, connectionId: "conn-1", eventType: "new_channel" };
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, deduped: false, eventType: "new_channel" });
  assert.equal(JSON.stringify(result.body).includes("must-not-echo"), false);
  assert.equal(JSON.stringify(result.body).includes("conn-1"), false);
});

test("tenant mismatch is exposed as conflict without detail leakage", async () => {
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers,
    body: {},
    async applyEvidence() {
      throw new ChannexChannelEvidenceError("OTA_DISTRIBUTION_TENANT_MISMATCH");
    },
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { ok: false, error: "OTA_DISTRIBUTION_TENANT_MISMATCH" });
});

test("canonical payload contract violations are permanent 400 responses", async () => {
  for (const code of [
    "OTA_CHANNEL_WEBHOOK_PAYLOAD_INVALID",
    "OTA_CHANNEL_EXTERNAL_PROPERTY_ID_INVALID",
    "OTA_CHANNEL_EXTERNAL_CONNECTION_ID_REQUIRED",
    "OTA_CHANNEL_OCCURRED_AT_INVALID",
    "OTA_CHANNEL_OCCURRED_AT_FUTURE_SKEW",
  ]) {
    const result = await processChannexChannelLifecycleWebhook({
      enabled: true,
      expectedSecret: "secret-1",
      headers,
      body: {},
      async applyEvidence() {
        throw new ChannexChannelEvidenceError(code);
      },
    });
    assert.equal(result.status, 400, code);
    assert.deepEqual(result.body, { ok: false, error: code });
  }
});

test("transient lifecycle ingestion failures return retryable 503 responses", async () => {
  for (const code of [
    "OTA_CHANNEL_PROPERTY_MAPPING_NOT_FOUND",
    "OTA_CHANNEL_CONNECTION_NOT_PREPARED",
    "OTA_CHANNEL_EVIDENCE_STATE_CONFLICT",
  ]) {
    const result = await processChannexChannelLifecycleWebhook({
      enabled: true,
      expectedSecret: "secret-1",
      headers,
      body: {},
      async applyEvidence() {
        throw new ChannexChannelEvidenceError(code);
      },
    });
    assert.equal(result.status, 503, code);
    assert.deepEqual(result.body, { ok: false, error: code });
  }
});

test("unknown runtime error is fail-closed", async () => {
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers,
    body: {},
    async applyEvidence() { throw new Error("database detail must not leak"); },
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: "OTA_CHANNEL_LIFECYCLE_INGEST_FAILED" });
});
