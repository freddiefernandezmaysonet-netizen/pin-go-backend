import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGuestJourneyAccessOwnerE14OwnerId,
  decideGuestAccessE15Reconciliation,
  guestAccessE15MarkerStateFromPayload,
  guestAccessE15NextAutomaticStep,
  isGuestAccessE15AutoResolvableAmbiguity,
  isGuestAccessE15AutoResolvableOwnerExhaustion,
  mapGuestJourneyAccessOwnerE14ProvisionResult,
} from "./guest-access-exit-closure-a.policy";

test("Closure A gives each Access Owner attempt a stable E14 owner id", () => {
  assert.equal(
    buildGuestJourneyAccessOwnerE14OwnerId({
      intentId: "intent-1",
      attemptNumber: 3,
    }),
    "guest-journey-access-owner:intent-1:3"
  );
});

test("Closure A maps E14 ambiguity to terminal intent ambiguity without replay", () => {
  const mapped = mapGuestJourneyAccessOwnerE14ProvisionResult(
    {
      status: "AMBIGUOUS",
      reason: "GUEST_ACCESS_PROVISION_RESULT_AMBIGUOUS_TIMEOUT",
      attemptCount: 1,
    },
    "grant-1"
  );
  assert.equal(mapped.proceed, false);
  if (!mapped.proceed) {
    assert.equal(mapped.completion.kind, "AMBIGUOUS");
    assert.equal(
      mapped.completion.errorCode,
      "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS"
    );
  }
});

test("Closure A maps pre-boundary E14 wait without provider replay", () => {
  const mapped = mapGuestJourneyAccessOwnerE14ProvisionResult(
    {
      status: "WAITING_FOR_EVIDENCE",
      reason: "CANONICAL_ACCESS_READINESS_NOT_ELIGIBLE",
      attemptCount: 1,
    },
    "grant-1"
  );
  assert.equal(mapped.proceed, false);
  if (!mapped.proceed) {
    assert.equal(mapped.completion.kind, "WAITING_FOR_EVIDENCE");
  }
});

test("Closure A returns successful E14 activation to the existing Access Owner completion path", () => {
  const activation = { ok: true, keyboardPwdId: 77 };
  const mapped = mapGuestJourneyAccessOwnerE14ProvisionResult(
    {
      status: "SUCCEEDED",
      activation,
      fenceCleared: true,
      attemptCount: 1,
    },
    "grant-1"
  );
  assert.equal(mapped.proceed, true);
  if (mapped.proceed) assert.equal(mapped.activation, activation);
});

test("Closure A parses only the durable E15 marker contract", () => {
  assert.equal(
    guestAccessE15MarkerStateFromPayload({
      e15: {
        version: "guest_access_ambiguity_reconciliation_e15_v1",
        state: "ABSENCE_OBSERVED",
      },
    }),
    "ABSENCE_OBSERVED"
  );
  assert.equal(
    guestAccessE15MarkerStateFromPayload({
      e15: { version: "other", state: "ABSENCE_OBSERVED" },
    }),
    null
  );
});

test("pending exact provider evidence keeps the existing E15 adoption path", () => {
  assert.equal(
    decideGuestAccessE15Reconciliation({
      grantStatus: "PENDING",
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      localKeyboardPwdId: null,
      secureCodePresent: false,
      provider: { kind: "EXACT_MATCH", keyboardPwdId: 77 },
    }),
    "ADOPT_PROVIDER_PRESENT"
  );
});

test("active exact matching provider evidence is classified as late success", () => {
  assert.equal(
    decideGuestAccessE15Reconciliation({
      grantStatus: "ACTIVE",
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      localKeyboardPwdId: 77,
      secureCodePresent: true,
      provider: { kind: "EXACT_MATCH", keyboardPwdId: 77 },
    }),
    "RECONCILE_LATE_SUCCESS"
  );
});

test("active provider absence is a manual conflict and can never be rearmed", () => {
  assert.equal(
    decideGuestAccessE15Reconciliation({
      grantStatus: "ACTIVE",
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      localKeyboardPwdId: 77,
      secureCodePresent: true,
      provider: { kind: "ABSENT" },
    }),
    "MANUAL_REVIEW_REQUIRED"
  );
});

test("active provider id mismatch is a manual conflict", () => {
  assert.equal(
    decideGuestAccessE15Reconciliation({
      grantStatus: "ACTIVE",
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      localKeyboardPwdId: 77,
      secureCodePresent: true,
      provider: { kind: "EXACT_MATCH", keyboardPwdId: 88 },
    }),
    "MANUAL_REVIEW_REQUIRED"
  );
});

test("incomplete inventory remains automatic verification", () => {
  assert.equal(
    decideGuestAccessE15Reconciliation({
      grantStatus: "PENDING",
      recoveryOperation: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
      localKeyboardPwdId: null,
      secureCodePresent: false,
      provider: { kind: "INCOMPLETE" },
    }),
    "VERIFY_PROVIDER_STATE"
  );
});

test("E15-enabled ambiguity is automatic unless durable evidence demands manual review", () => {
  assert.equal(
    isGuestAccessE15AutoResolvableAmbiguity({
      e15Enabled: true,
      markerState: null,
    }),
    true
  );
  assert.equal(
    isGuestAccessE15AutoResolvableAmbiguity({
      e15Enabled: true,
      markerState: "MANUAL_REVIEW_REQUIRED",
    }),
    false
  );
});

test("only ambiguous provisioning exhaustion is delegated to E15", () => {
  assert.equal(
    isGuestAccessE15AutoResolvableOwnerExhaustion({
      e15Enabled: true,
      intentType: "REQUEST_ACCESS_PROVISIONING",
      lastError: "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS",
    }),
    true
  );
  assert.equal(
    isGuestAccessE15AutoResolvableOwnerExhaustion({
      e15Enabled: true,
      intentType: "REQUEST_ACCESS_REVOCATION_CHECK",
      lastError: "ACCESS_REVOCATION_PROVIDER_RESULT_AMBIGUOUS",
    }),
    false
  );
});

test("confirmed provider absence advertises controlled rearm as the next automatic step", () => {
  assert.match(
    guestAccessE15NextAutomaticStep("CONFIRMED_ABSENT_REARMABLE"),
    /controlled rearm/i
  );
});
