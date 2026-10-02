import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTwilioSmsFailure,
  smsFailureOperationalKey,
  type SmsDeliveryEvidence,
  type SmsReservationEvidence,
} from "./twilio-sms-failure.policy.js";

const SID = "SM" + "1".repeat(32);
const now = new Date("2026-10-02T16:00:04.000Z");
function message(overrides: Partial<SmsDeliveryEvidence> = {}): SmsDeliveryEvidence {
  return {
    messageLogId: "msg-fixture", providerMessageId: SID,
    provider: "twilio", channel: "sms", communicationType: "PRECHECKIN",
    sendAttemptStatus: "SENT", providerDeliveryStatus: "UNDELIVERED", providerErrorCode: "30005",
    organizationId: "org-fixture", propertyId: "property-fixture", reservationId: "reservation-fixture",
    ...overrides,
  };
}
function reservation(overrides: Partial<SmsReservationEvidence> = {}): SmsReservationEvidence {
  return {
    id: "reservation-fixture", organizationId: "org-fixture", propertyId: "property-fixture",
    status: "ACTIVE", cancelledAt: null,
    checkIn: new Date("2026-10-02T20:00:00.000Z"),
    checkOut: new Date("2026-10-04T15:00:00.000Z"),
    ...overrides,
  };
}
function evaluate(m = message(), r: SmsReservationEvidence | null = reservation()) {
  return evaluateTwilioSmsFailure({ message: m, reservation: r, now });
}

test("PRECHECKIN local SENT plus carrier UNDELIVERED/30005 requires host action without replay", () => {
  const result = evaluate();
  assert.equal(result.kind, "HOST_ACTION_REQUIRED");
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(result.blockAutomaticReplay, true);
  assert.equal(result.hostAction?.severity, "WARNING");
  assert.equal(result.hostAction?.canAutoResolve, false);
  assert.equal(result.hostAction?.autoResolveStatus, "NOT_SUPPORTED");
  assert.equal(result.hostAction?.autoResolveActionCode, null);
  assert.equal(result.hostAction?.nextAutomaticStep, null);
  assert.equal(result.hostAction?.metadata.providerErrorCode, "30005");
  assert.equal(result.hostAction?.metadata.providerDeliveryStatus, "UNDELIVERED");
});

test("access-passcode failure is critical without claiming a failed lock or changing access", () => {
  const result = evaluate(message({ communicationType: "GUEST_ACCESS_PASSCODE" }));
  assert.equal(result.hostAction?.severity, "CRITICAL");
  assert.equal(result.hostAction?.actionTarget, "RESERVATION");
  assert.equal(result.hostAction?.responsibleActor, "HOST");
  assert.equal(result.hostAction?.visibility, "HOST");
});

for (const sendAttemptStatus of ["SENT", "FAILED", "FAILED_FINAL", "E7_SENDING", null]) {
  test(`carrier failure does not depend on local send status ${sendAttemptStatus}`, () => {
    const result = evaluate(message({ sendAttemptStatus }));
    assert.equal(result.kind, "HOST_ACTION_REQUIRED");
    assert.equal(result.deliveryConfirmed, false);
    assert.equal(result.blockAutomaticReplay, true);
  });
}
for (const status of ["ACCEPTED", "QUEUED", "SENDING", "SENT", null]) {
  test(`${status} without a receipt never certifies handset delivery`, () => {
    const result = evaluate(message({ providerDeliveryStatus: status, providerErrorCode: null }));
    assert.equal(result.deliveryConfirmed, false);
    assert.equal(result.hostAction, null);
  });
}
for (const status of ["DELIVERED", "READ"]) {
  test(`${status} is delivery evidence and must not prompt another automatic send`, () => {
    const result = evaluate(message({ providerDeliveryStatus: status, providerErrorCode: null }));
    assert.equal(result.deliveryConfirmed, true);
    assert.equal(result.blockAutomaticReplay, true);
    assert.equal(result.hostAction, null);
  });
}
for (const status of ["SENT", "DELIVERED", "QUEUED", "UNKNOWN", null]) {
  test(`30005 with incompatible provider status ${status} requires evidence review`, () => {
    const result = evaluate(message({ providerDeliveryStatus: status }));
    assert.equal(result.kind, "REVIEW_EVIDENCE");
    assert.equal(result.deliveryConfirmed, false);
    assert.equal(result.blockAutomaticReplay, true);
    assert.equal(result.hostAction, null);
  });
}
for (const override of [
  { provider: "resend" }, { provider: "TWILIO" }, { channel: "email" }, { channel: "whatsapp" },
]) {
  test(`does not reinterpret another transport ${JSON.stringify(override)}`, () => {
    const result = evaluate(message(override));
    assert.equal(result.reason, "OUT_OF_SCOPE_PROVIDER_OR_CHANNEL");
    assert.equal(result.hostAction, null);
  });
}
for (const providerErrorCode of ["30003", "30007", "21610", "prefix30005", "300050", null]) {
  test(`does not reclassify error ${providerErrorCode} as unknown handset`, () => {
    const result = evaluate(message({ providerErrorCode }));
    assert.equal(result.reason, "NO_30005_DELIVERY_FAILURE");
    assert.equal(result.hostAction, null);
  });
}

test("FAILED/30005 is a terminal failure too", () => {
  const result = evaluate(message({ providerDeliveryStatus: "failed", providerErrorCode: " 30005 " }));
  assert.equal(result.kind, "HOST_ACTION_REQUIRED");
  assert.equal(result.hostAction?.metadata.providerDeliveryStatus, "FAILED");
});
for (const override of [
  { messageLogId: "" }, { messageLogId: "https://private.invalid/token" },
  { providerMessageId: null }, { providerMessageId: "SMshort" },
]) {
  test(`fails closed without exact attempt correlation ${JSON.stringify(override)}`, () => {
    const result = evaluate(message(override));
    assert.equal(result.reason, "MESSAGE_CORRELATION_MISSING");
    assert.equal(result.blockAutomaticReplay, true);
    assert.equal(result.hostAction, null);
  });
}
for (const override of [
  { organizationId: "different-org" }, { propertyId: "different-property" },
  { reservationId: "different-reservation" }, { organizationId: null }, { propertyId: null },
]) {
  test(`cannot attach an incident to inconsistent scope ${JSON.stringify(override)}`, () => {
    const result = evaluate(message(override));
    assert.equal(result.reason, "RESERVATION_SCOPE_MISMATCH");
    assert.equal(result.hostAction, null);
  });
}

test("a missing reservation cannot create an unscoped host action", () => {
  assert.equal(evaluate(message(), null).reason, "RESERVATION_SCOPE_MISMATCH");
});
for (const override of [
  { status: "CANCELLED" }, { cancelledAt: new Date("2026-10-02T15:00:00.000Z") },
]) {
  test(`no new arrival/access action for cancelled reservation ${JSON.stringify(override)}`, () => {
    const result = evaluate(message(), reservation(override));
    assert.equal(result.reason, "RESERVATION_CANCELLED");
    assert.equal(result.blockAutomaticReplay, true);
  });
}

test("unexpected reservation status requires review", () => {
  assert.equal(evaluate(message(), reservation({ status: "ARCHIVED" })).reason, "RESERVATION_STATE_UNSUPPORTED");
});
for (const override of [
  { checkIn: new Date("invalid") }, { checkOut: new Date("invalid") },
  { checkOut: new Date("2026-10-02T20:00:00.000Z") },
]) {
  test(`rejects invalid reservation chronology ${JSON.stringify(override)}`, () => {
    assert.equal(evaluate(message(), reservation(override)).reason, "RESERVATION_DATES_INVALID");
  });
}

test("checkout boundary suppresses a new stale arrival/access action, not the failure evidence", () => {
  const r = reservation();
  const result = evaluateTwilioSmsFailure({ message: message(), reservation: r, now: r.checkOut });
  assert.equal(result.reason, "STAY_ENDED");
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(result.blockAutomaticReplay, true);
});

test("arrival/access failure during an active stay remains actionable", () => {
  const result = evaluateTwilioSmsFailure({ message: message(), reservation: reservation(), now: new Date("2026-10-03T02:00:00.000Z") });
  assert.equal(result.kind, "HOST_ACTION_REQUIRED");
});

test("invalid server clock does not fabricate an action timestamp", () => {
  assert.equal(evaluateTwilioSmsFailure({ message: message(), reservation: reservation(), now: new Date("invalid") }).reason, "INVALID_NOW");
});
for (const communicationType of ["CHECKOUT", "CLEANING_CONFIRMATION", null]) {
  test(`does not mislabel communication ${communicationType} as failed guest arrival`, () => {
    const result = evaluate(message({ communicationType }));
    assert.equal(result.reason, "COMMUNICATION_TYPE_OUT_OF_SCOPE");
    assert.equal(result.blockAutomaticReplay, true);
    assert.equal(result.hostAction, null);
  });
}
for (const workflowState of ["RESOLVED", "ACTION_REQUIRED", "WAITING", "AUTO_RESOLVING"]) {
  test(`duplicate evidence preserves the existing ${workflowState} workflow`, () => {
    const r = reservation();
    const result = evaluateTwilioSmsFailure({
      message: message(), reservation: r, now,
      existingIssue: { operationalKey: smsFailureOperationalKey("msg-fixture", SID),
        organizationId: r.organizationId, propertyId: r.propertyId, reservationId: r.id, workflowState },
    });
    assert.equal(result.hostAction, null);
    assert.equal(result.blockAutomaticReplay, true);
    assert.equal(result.reason, workflowState === "RESOLVED" ? "EXISTING_ISSUE_RESOLVED" : "EXISTING_ISSUE_OWNS_RECOVERY");
  });
}

test("another tenant's resolved issue cannot suppress this failure", () => {
  const result = evaluateTwilioSmsFailure({
    message: message(), reservation: reservation(), now,
    existingIssue: { operationalKey: smsFailureOperationalKey("msg-fixture", SID),
      organizationId: "different-org", propertyId: "property-fixture", reservationId: "reservation-fixture", workflowState: "RESOLVED" },
  });
  assert.equal(result.reason, "EXISTING_ISSUE_SCOPE_MISMATCH");
});

test("a new attempt SID cannot inherit or overwrite the old attempt's incident", () => {
  assert.notEqual(smsFailureOperationalKey("msg-fixture", SID), smsFailureOperationalKey("msg-fixture", "SM" + "2".repeat(32)));
});

test("correlation helper refuses invalid or unbounded keys", () => {
  assert.throws(() => smsFailureOperationalKey("x".repeat(161), SID), /SMS_FAILURE_INVALID_CORRELATION/);
  assert.throws(() => smsFailureOperationalKey("msg-fixture", "secret"), /SMS_FAILURE_INVALID_CORRELATION/);
});

test("action contains only allowlisted metadata, no phone, guest token, body or provider free text", () => {
  const contaminated = { ...message(), to: "+17875550101", body: "PRIVATE-CODE-1234", providerErrorMessage: "PRIVATE-TOKEN-secret" };
  const action = evaluate(contaminated).hostAction!;
  assert.deepEqual(Object.keys(action.metadata).sort(), [
    "automatedSameDestinationReplay", "communicationType", "messageLogId", "provider", "providerDeliveryStatus", "providerErrorCode", "providerMessageId", "version",
  ].sort());
  assert.doesNotMatch(JSON.stringify(action), /17875550101|PRIVATE-CODE|PRIVATE-TOKEN/);
});

test("evaluation is deterministic and leaves all input evidence unchanged", () => {
  const m = Object.freeze(message());
  const r = Object.freeze(reservation());
  const before = JSON.stringify({ m, r, now });
  assert.deepEqual(evaluate(m, r), evaluate(m, r));
  assert.equal(JSON.stringify({ m, r, now }), before);
  const action = evaluate(m, r).hostAction!;
  action.occurredAt.setFullYear(2030);
  assert.equal(now.toISOString(), "2026-10-02T16:00:04.000Z");
});
