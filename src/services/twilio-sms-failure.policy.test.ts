import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTwilioSmsFailure,
  smsFailureOperationalKey,
  type SmsDeliveryEvidence,
  type SmsReservationEvidence,
  type SmsRetryEvidence,
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
  // Retained host-action regressions explicitly model an already-used retry.
  return evaluateTwilioSmsFailure({ message: m, reservation: r, now,
    recovery: recovery({ retriesUsed: 1 }) });
}

test("PRECHECKIN after the one retry fails requires host action, not another replay", () => {
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

test("access-passcode failure after retry is critical without changing access", () => {
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

test("access failure after exhausted retry during an active stay remains actionable", () => {
  const result = evaluateTwilioSmsFailure({ message: message({ communicationType: "GUEST_ACCESS_PASSCODE" }),
    reservation: reservation(), now: new Date("2026-10-03T02:00:00.000Z"),
    recovery: recovery({ retriesUsed: 1 }) });
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
    "automatedSameMessageReplay", "communicationType", "messageLogId", "provider", "providerDeliveryStatus", "providerErrorCode", "providerMessageId", "version",
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


// Thirty minutes and fifteen-minute spacing are example policy inputs, not live settings.
function recovery(overrides: Partial<SmsRetryEvidence> = {}): SmsRetryEvidence {
  return {
    messageLogId: "msg-fixture", providerMessageId: SID, retriesUsed: 0,
    retryState: "AVAILABLE", firstFailureAt: new Date(now),
    retryNotBefore: new Date(now.getTime() + 30 * 60_000),
    contentValidUntil: reservation().checkOut, currentRecipientAndContent: true,
    minimumSpacingMs: 15 * 60_000,
    nextScheduledMessage: {
      messageKey: "scheduled-access", organizationId: "org-fixture",
      propertyId: "property-fixture", reservationId: "reservation-fixture",
      scheduledAt: new Date("2026-10-02T18:00:00.000Z"),
    },
    ...overrides,
  };
}
function initial(evidence: SmsRetryEvidence | null = recovery(), at = now,
  m = message(), r = reservation()) {
  return evaluateTwilioSmsFailure({ message: m, reservation: r, now: at, recovery: evidence });
}

test("first 30005 waits for one delayed retry without demanding immediate host action", () => {
  const result = initial();
  assert.equal(result.kind, "WAIT_FOR_RETRY");
  assert.equal(result.hostAction, null);
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(result.blockAutomaticReplay, true);
  assert.equal(result.blockOtherScheduledMessages, false);
  assert.equal(result.retryPlan?.retryOrdinal, 1);
  assert.equal(result.retryPlan?.notBefore.toISOString(), "2026-10-02T16:30:04.000Z");
});

test("retry becomes eligible at its due instant, never immediately at the carrier failure", () => {
  const e = recovery();
  assert.equal(initial(e, new Date(e.retryNotBefore.getTime() - 1)).kind, "WAIT_FOR_RETRY");
  const result = initial(e, e.retryNotBefore);
  assert.equal(result.kind, "RETRY_ELIGIBLE");
  assert.equal(result.blockAutomaticReplay, false);
  assert.equal(result.hostAction, null);
  assert.equal(result.retryPlan?.failedProviderMessageId, SID);
  assert.equal(result.retryPlan?.validUntil.toISOString(), "2026-10-02T17:45:00.000Z");
});

test("a repeated callback cannot reset the anchored delay or change the one-retry key", () => {
  const first = initial();
  const again = initial(recovery(), new Date(now.getTime() + 10 * 60_000));
  assert.deepEqual(first.retryPlan, again.retryPlan);
  assert.equal(first.retryPlan?.recoveryKey, "GUEST_SMS_RETRY:msg-fixture:1");
});

test("changing provider SID does not create a second automatic retry budget", () => {
  const providerMessageId = "SM" + "2".repeat(32);
  const result = initial(recovery({ retriesUsed: 1, providerMessageId }),
    recovery().retryNotBefore, message({ providerMessageId }));
  assert.equal(result.kind, "HOST_ACTION_REQUIRED");
  assert.equal(result.reason, "SAME_MESSAGE_RETRY_EXHAUSTED");
  assert.equal(result.retryPlan, null);
  assert.equal(result.blockOtherScheduledMessages, false);
});

for (const retriesUsed of [1, 2, 20]) {
  test(`retry budget already used ${retriesUsed} times cannot start another retry`, () => {
    const result = initial(recovery({ retriesUsed }));
    assert.equal(result.kind, "HOST_ACTION_REQUIRED");
    assert.equal(result.retryPlan, null);
    assert.equal(result.blockAutomaticReplay, true);
  });
}
for (const retryState of ["CLAIMED", "OUTCOME_UNKNOWN"] as const) {
  test(`a ${retryState} retry is not repeated even when no new receipt exists`, () => {
    const result = initial(recovery({ retryState, retriesUsed: 1 }));
    assert.equal(result.kind, "REVIEW_EVIDENCE");
    assert.equal(result.reason, "RETRY_ALREADY_CLAIMED_OR_OUTCOME_UNKNOWN");
    assert.equal(result.retryPlan, null);
    assert.equal(result.blockOtherScheduledMessages, false);
  });
}

test("missing recovery evidence cannot be treated as zero prior retries", () => {
  assert.equal(initial(null).reason, "RETRY_EVIDENCE_MISSING");
});
for (const patch of [
  { messageLogId: "other-message" }, { providerMessageId: "SM" + "2".repeat(32) },
]) {
  test(`stale or foreign retry evidence is rejected ${JSON.stringify(patch)}`, () => {
    assert.equal(initial(recovery(patch)).reason, "RETRY_CORRELATION_MISMATCH");
  });
}
for (const patch of [
  { retriesUsed: -1 }, { retriesUsed: 0.5 }, { retriesUsed: NaN },
  { firstFailureAt: new Date("invalid") }, { firstFailureAt: new Date(now.getTime() + 1) },
  { retryNotBefore: new Date(now) }, { retryNotBefore: new Date("invalid") },
  { contentValidUntil: new Date("invalid") },
  { minimumSpacingMs: 0 }, { minimumSpacingMs: 3_600_001 },
]) {
  test(`invalid bounded retry evidence fails closed ${JSON.stringify(patch)}`, () => {
    const result = initial(recovery(patch));
    assert.equal(result.reason, "RETRY_EVIDENCE_INVALID");
    assert.equal(result.retryPlan, null);
  });
}

test("changed recipient or instructions require review, not replay of an old log body", () => {
  assert.equal(initial(recovery({ currentRecipientAndContent: false })).reason, "RECIPIENT_OR_CONTENT_CHANGED");
});

test("next scheduled communication takes precedence over a retry too close to it", () => {
  const e = recovery();
  e.nextScheduledMessage!.scheduledAt = new Date(e.retryNotBefore.getTime() + e.minimumSpacingMs);
  const result = initial(e);
  assert.equal(result.kind, "WAIT_FOR_NEXT_MESSAGE");
  assert.equal(result.retryPlan, null);
  assert.equal(result.hostAction, null);
  assert.equal(result.blockOtherScheduledMessages, false);
  assert.equal(result.deliveryConfirmed, false);
});

test("retry is available when its due time is outside the next-message spacing boundary", () => {
  const e = recovery();
  e.nextScheduledMessage!.scheduledAt = new Date(e.retryNotBefore.getTime() + e.minimumSpacingMs + 1);
  assert.equal(initial(e, e.retryNotBefore).kind, "RETRY_ELIGIBLE");
});

test("a delayed worker yields the old retry when the 2 pm scheduled message is close or due", () => {
  for (const at of ["2026-10-02T17:50:00Z", "2026-10-02T18:00:00Z"]) {
    const result = initial(recovery(), new Date(at));
    assert.equal(result.kind, "WAIT_FOR_NEXT_MESSAGE");
    assert.equal(result.blockOtherScheduledMessages, false);
    assert.equal(result.deliveryConfirmed, false, "scheduled does not prove delivered");
    assert.equal(result.retryPlan, null);
  }
});

for (const patch of [
  { organizationId: "other-org" }, { propertyId: "other-property" },
  { reservationId: "other-reservation" }, { messageKey: "msg-fixture" },
  { messageKey: "https://private.invalid/token" }, { scheduledAt: new Date("invalid") },
]) {
  test(`next-message evidence requires its own current scope ${JSON.stringify(patch)}`, () => {
    const e = recovery();
    e.nextScheduledMessage = { ...e.nextScheduledMessage!, ...patch };
    assert.equal(initial(e).reason, "NEXT_MESSAGE_SCOPE_OR_TIME_INVALID");
  });
}

test("no upcoming communication still allows the one delayed retry", () => {
  assert.equal(initial(recovery({ nextScheduledMessage: null })).kind, "WAIT_FOR_RETRY");
});

test("expired content is not resent and does not block other scheduled messages", () => {
  const result = initial(recovery({ contentValidUntil: new Date(now) }));
  assert.equal(result.reason, "MESSAGE_EXPIRED");
  assert.equal(result.retryPlan, null);
  assert.equal(result.blockOtherScheduledMessages, false);
});

test("precheckin cannot be replayed at checkin even with a longer content window", () => {
  const result = initial(recovery(), reservation().checkIn);
  assert.equal(result.reason, "MESSAGE_EXPIRED");
});

test("retry that cannot fit before content expiry needs an action rather than unsafe sending", () => {
  const e = recovery({ nextScheduledMessage: null, contentValidUntil: new Date(now.getTime() + 10 * 60_000) });
  const result = initial(e);
  assert.equal(result.reason, "RETRY_WINDOW_UNAVAILABLE");
  assert.equal(result.hostAction?.severity, "WARNING");
  assert.equal(result.retryPlan, null);
});

test("a separate access message retains its own retry budget after precheckin exhausts its retry", () => {
  assert.equal(initial(recovery({ retriesUsed: 1 })).kind, "HOST_ACTION_REQUIRED");
  const accessMessage = message({ messageLogId: "access-msg", communicationType: "GUEST_ACCESS_PASSCODE" });
  const later = initial(recovery({ messageLogId: "access-msg", nextScheduledMessage: null }),
    recovery().retryNotBefore, accessMessage);
  assert.equal(later.kind, "RETRY_ELIGIBLE");
  assert.equal(later.retryPlan?.recoveryKey, "GUEST_SMS_RETRY:access-msg:1");
});

test("delivery receipt, opt-out and unrelated errors never generate this retry plan", () => {
  for (const patch of [
    { providerDeliveryStatus: "DELIVERED", providerErrorCode: null },
    { providerDeliveryStatus: "SENT", providerErrorCode: null },
    { providerErrorCode: "21610" }, { providerErrorCode: "30007" },
  ]) {
    const result = initial(recovery(), now, message(patch));
    assert.equal(result.retryPlan, null);
    assert.equal(result.blockOtherScheduledMessages, false, "other policies retain their own blocking authority");
  }
});

test("retry plan dates do not alias trusted evidence or mutate its delay", () => {
  const e = recovery();
  const original = e.retryNotBefore.toISOString();
  const result = initial(e);
  result.retryPlan!.notBefore.setUTCFullYear(2030);
  assert.equal(e.retryNotBefore.toISOString(), original);
});
