import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const reconciler = source(
  "./damage-case-mission-control-reconciliation.service.ts"
);
const retryWorker = source("../workers/message.retry.worker.ts");

test("selects missing and stale projections in a bounded deterministic batch", () => {
  assert.match(reconciler, /oi\."id" IS NULL/);
  assert.match(reconciler, /oi\."lastSignalAt" < dc\."updatedAt"/);
  assert.match(reconciler, /damageCaseStatus/);
  assert.match(reconciler, /guestResponse/);
  assert.match(reconciler, /damageNoticeDeliveryStatus/);
  assert.match(reconciler, /damageNoticeRetryCount/);
  assert.match(reconciler, /closureNoticeRequired/);
  assert.match(reconciler, /closureNoticeDeliveryStatus/);
  assert.match(reconciler, /closureNoticeRetryCount/);
  assert.match(
    reconciler,
    /PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE/
  );
  assert.match(reconciler, /Math\.min\(100/);
  assert.match(reconciler, /ORDER BY dc\."updatedAt" ASC, dc\."id" ASC/);
  assert.match(reconciler, /LIMIT \$\{boundedBatchSize\}/);
});

test("reuses the canonical safe projection and is integrated in the serialized retry tick", () => {
  assert.match(reconciler, /syncDamageCaseMissionControlSafely/);
  assert.match(retryWorker, /reconcileDamageCaseMissionControl/);
  assert.match(
    retryWorker,
    /await reconcileDamageCaseMissionControl\([\s\S]*batchSize: BATCH_SIZE[\s\S]*maxMessageRetries: MAX_RETRIES/
  );
});

test("contains no notification, financial execution or Damage Case mutation", () => {
  assert.doesNotMatch(reconciler, /sendPropertyProtection|sendEmail|sendSms/);
  assert.doesNotMatch(
    reconciler,
    /PaymentIntent|paymentIntents\.|charges\.|capture\(|refunds\./
  );
  assert.doesNotMatch(reconciler, /damageCase\.(create|update|delete|upsert)/);
});
