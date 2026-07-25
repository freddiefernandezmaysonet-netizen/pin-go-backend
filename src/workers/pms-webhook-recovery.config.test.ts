import assert from "node:assert/strict";
import test from "node:test";
import { resolvePmsWebhookRecoveryConfig } from "./pms-webhook-recovery.config";

test("recovery worker config uses safe defaults", () => {
  assert.deepEqual(resolvePmsWebhookRecoveryConfig({}), {
    pollMs: 60_000,
    batchSize: 20,
    maxAttempts: 8,
    pendingMinAgeMs: 30_000,
    retryDelayMs: 60_000,
    staleProcessingMs: 600_000,
  });
});

test("recovery worker config accepts explicit certification values", () => {
  assert.deepEqual(
    resolvePmsWebhookRecoveryConfig({
      PMS_WEBHOOK_RECOVERY_POLL_MS: "5000",
      PMS_WEBHOOK_RECOVERY_BATCH_SIZE: "20",
      PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS: "8",
      PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS: "0",
      PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS: "30000",
      PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS: "600000",
    }),
    {
      pollMs: 5000,
      batchSize: 20,
      maxAttempts: 8,
      pendingMinAgeMs: 0,
      retryDelayMs: 30000,
      staleProcessingMs: 600000,
    }
  );
});

for (const [name, value] of [
  ["PMS_WEBHOOK_RECOVERY_POLL_MS", "not-a-number"],
  ["PMS_WEBHOOK_RECOVERY_BATCH_SIZE", "1.5"],
  ["PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS", "0"],
  ["PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS", "-1"],
  ["PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS", "999"],
  ["PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS", "59999"],
] as const) {
  test(`recovery worker config rejects invalid ${name}`, () => {
    assert.throws(
      () => resolvePmsWebhookRecoveryConfig({ [name]: value }),
      new RegExp(`${name}_INVALID`)
    );
  });
}
