import assert from "node:assert/strict";
import test from "node:test";
import { PmsProvider } from "@prisma/client";
import { getPmsWebhookExecutionTarget } from "./pms-webhook-execution.policy";

test("Channex webhook execution belongs only to the standalone worker", () => {
  assert.equal(
    getPmsWebhookExecutionTarget(PmsProvider.CHANNEX),
    "STANDALONE_RECOVERY_WORKER"
  );
});

test("legacy PMS providers preserve API setImmediate execution", () => {
  const legacyProviders = [
    PmsProvider.GUESTY,
    PmsProvider.CLOUDBEDS,
    PmsProvider.HOSTAWAY,
    PmsProvider.LODGIFY,
    PmsProvider.GENERIC,
  ];

  for (const provider of legacyProviders) {
    assert.equal(
      getPmsWebhookExecutionTarget(provider),
      "API_LEGACY_SET_IMMEDIATE"
    );
  }
});
