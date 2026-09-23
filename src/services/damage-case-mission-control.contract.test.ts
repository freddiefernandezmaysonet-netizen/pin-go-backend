import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const projector = source("./damage-case-mission-control.service.ts");
const routes = source("../routes/dashboard.damage-cases.routes.ts");
const guestNotice = source("./damage-case-guest-notification.service.ts");
const guestResponse = source("./damage-case-guest-response.service.ts");
const retryWorker = source("../workers/message.retry.worker.ts");

test("synchronizes every host-owned Damage Case mutation", () => {
  assert.match(routes, /damageCase\.create[\s\S]*syncDamageCaseMissionControlSafely/);
  assert.match(routes, /damageCase\.update[\s\S]*syncDamageCaseMissionControlSafely/);
  assert.match(routes, /HOST_REVIEW[\s\S]*syncDamageCaseMissionControlSafely/);
  assert.match(routes, /CLOSED_NO_CHARGE[\s\S]*syncDamageCaseMissionControlSafely/);
});

test("synchronizes guest notices, responses, closure delivery and automatic retry", () => {
  assert.match(guestNotice, /syncDamageCaseMissionControlSafely/);
  assert.match(guestResponse, /syncDamageCaseMissionControlSafely/);
  assert.match(
    retryWorker,
    /PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE[\s\S]*syncDamageCaseMissionControlSafely/
  );
  assert.match(
    retryWorker,
    /processPropertyProtectionGuestClosureRetries[\s\S]*syncDamageCaseMissionControlSafely/
  );
  assert.match(
    retryWorker,
    /processPropertyProtectionHostResponseRetries[\s\S]*syncDamageCaseMissionControlSafely/
  );
  assert.match(
    guestResponse,
    /const hostNotification = await notifyHostSafely\(input\);[\s\S]*await syncDamageCaseMissionControlSafely[\s\S]*return hostNotification/
  );
  assert.equal(
    guestResponse.match(/await syncDamageCaseMissionControlSafely/g)?.length,
    1
  );
  assert.match(
    projector,
    /PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE/
  );
  assert.match(
    projector,
    /PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE/
  );
  assert.match(projector, /message\.to\.trim\(\)\.toLowerCase\(\)/);
  assert.doesNotMatch(projector, /to:\s*\{\s*in:\s*recipientEmails/);
});

test("persists one canonical issue through the existing Operational Intelligence service", () => {
  assert.match(projector, /PROPERTY_PROTECTION_DAMAGE_CASE:\$\{damageCase\.id\}/);
  assert.match(projector, /upsertOperationalIssue/);
  assert.match(projector, /organizationId:\s*damageCase\.reservation\.property\.organizationId/);
  assert.match(projector, /propertyId:\s*damageCase\.reservation\.propertyId/);
  assert.match(projector, /reservationId:\s*damageCase\.reservationId/);
});

test("uses the explicit APMS reopen contract when closure delivery becomes incomplete", () => {
  assert.match(projector, /currentIssue\?\.workflowState === "RESOLVED"/);
  assert.match(projector, /reopenOperationalIssue/);
  assert.match(
    projector,
    /PROPERTY_PROTECTION_CLOSURE_DELIVERY_INCOMPLETE/
  );
  assert.match(
    projector,
    /PROPERTY_PROTECTION_HOST_RESPONSE_DELIVERY_INCOMPLETE/
  );
  assert.match(
    projector,
    /PROPERTY_PROTECTION_FINAL_GUEST_RESPONSE_ACTIVE/
  );
  assert.match(
    projector,
    /PROPERTY_PROTECTION_CANONICAL_STATE_RECONCILIATION/
  );
  assert.match(projector, /deliveryObservedAt/);
  assert.match(
    projector,
    /ApmsOperationalReopenSourceNotResolvedError/
  );
});

test("contains no financial execution primitive", () => {
  for (const file of [projector, routes, guestNotice, guestResponse]) {
    assert.doesNotMatch(file, /PaymentIntent|paymentIntents\.|charges\.|capture\(|refunds\./);
  }
  assert.doesNotMatch(projector, /autoResolveActionCode:\s*["']/);
});
