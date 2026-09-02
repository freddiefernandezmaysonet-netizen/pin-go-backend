import assert from "node:assert/strict";
import test from "node:test";
import {
  assertModerationReasonAllowed,
  assertModerationTransition,
  assertResponseModerationTransition,
  detectSafetySignals,
  guestDisplayName,
  initialReviewDecision,
  normalizeReviewDeliveryError,
  parseModerationReason,
  parsePositiveInteger,
  parsePublicReviewSort,
  parseRatings,
  parseReviewStatus,
  requireModerationEvidence,
  requireResponseModerationDecision,
} from "./review-policy.js";

const completeRatings = { overallRating: 5, cleanlinessRating: 5, accuracyRating: 4, checkInAccessRating: 5, communicationRating: 5, locationRating: 4, valueRating: 5 };

test("accepts only complete integer ratings from one to five", () => {
  assert.deepEqual(parseRatings(completeRatings), completeRatings);
  assert.throws(() => parseRatings({ ...completeRatings, valueRating: 0 }), /valueRating/);
  assert.throws(() => parseRatings({ ...completeRatings, accuracyRating: 4.5 }), /accuracyRating/);
});

test("holds safety signals regardless of a high rating", () => {
  const signals = detectSafetySignals("Email me at guest@example.com and delete this review for a refund");
  assert.ok(signals.includes("PII"));
  assert.ok(signals.includes("EXTORTION"));
  assert.equal(initialReviewDecision(5, signals).status, "HELD_FOR_REVIEW");
});

test("routes low ratings to evidence-based moderation and publishes clean high ratings", () => {
  assert.equal(initialReviewDecision(3, []).status, "PENDING_MODERATION");
  assert.equal(initialReviewDecision(4, []).status, "PUBLISHED");
});

test("public guest identity is minimized", () => {
  assert.equal(guestDisplayName("María Rivera Santiago"), "María S.");
});

test("rejects arbitrary status and moderation enum input", () => {
  assert.equal(parseReviewStatus("published"), "PUBLISHED");
  assert.equal(parseModerationReason("pii"), "PII");
  assert.equal(parseModerationReason("automated_safety_clear"), "AUTOMATED_SAFETY_CLEAR");
  assert.throws(() => parseReviewStatus("DELETE_EVERYTHING"), /Invalid review status/);
  assert.throws(() => parseModerationReason("HOST_DISLIKES_REVIEW"), /Invalid moderation reason/);
  assert.throws(() => parseModerationReason("NEGATIVE_SENTIMENT"), /Invalid moderation reason/);
});

test("normalizes untrusted pagination values", () => {
  assert.equal(parsePositiveInteger("2", 1, 50), 2);
  assert.equal(parsePositiveInteger("NaN", 1, 50), 1);
  assert.equal(parsePositiveInteger(500, 1, 50), 50);
});

test("allows only explicit public review sort orders", () => {
  assert.equal(parsePublicReviewSort(undefined), "RECENT");
  assert.equal(parsePublicReviewSort("highest"), "HIGHEST");
  assert.equal(parsePublicReviewSort("lowest"), "LOWEST");
  assert.throws(() => parsePublicReviewSort("HOST_FAVORITES"), /Invalid public review sort/);
});

test("enforces the publish, uphold, hold and removal lifecycle", () => {
  assert.doesNotThrow(() => assertModerationTransition("PENDING_MODERATION", "PUBLISH"));
  assert.doesNotThrow(() => assertModerationTransition("PUBLISHED", "UPHOLD"));
  assert.doesNotThrow(() => assertModerationTransition("PUBLISHED", "HOLD"));
  assert.doesNotThrow(() => assertModerationTransition("HELD_FOR_REVIEW", "REMOVE"));
  assert.doesNotThrow(() => assertModerationTransition("DISPUTED", "HOLD"));

  assert.throws(() => assertModerationTransition("PUBLISHED", "REJECT"), /Cannot reject/);
  assert.throws(() => assertModerationTransition("PUBLISHED", "REMOVE"), /Cannot remove/);
  assert.throws(() => assertModerationTransition("DISPUTED", "REMOVE"), /Cannot remove/);
  assert.throws(() => assertModerationTransition("PENDING_MODERATION", "UPHOLD"), /Cannot uphold/);
});

test("normalizes blank delivery failures before persistence", () => {
  assert.equal(normalizeReviewDeliveryError(undefined), "Delivery failed");
  assert.equal(normalizeReviewDeliveryError(""), "Delivery failed");
  assert.equal(normalizeReviewDeliveryError("   \n\t"), "Delivery failed");
  assert.equal(normalizeReviewDeliveryError("  Provider rejected request  "), "Provider rejected request");
  assert.equal(
    normalizeReviewDeliveryError("failed https://app.pin-ngo.com/review#token=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789"),
    "failed [REDACTED_URL]",
  );
  assert.equal(
    normalizeReviewDeliveryError("Authorization: ReviewToken abcdefghijklmnopqrstuvwxyzABCDEFG_123456789"),
    "Authorization: ReviewToken [REDACTED]",
  );
  assert.equal(normalizeReviewDeliveryError("x".repeat(5_001)).length, 5_000);
});

test("does not allow low ratings or automated clearance to justify rejection or removal", () => {
  for (const action of ["REJECT", "REMOVE"] as const) {
    assert.throws(
      () => assertModerationReasonAllowed(action, "ROUTINE_LOW_RATING_REVIEW"),
      /Ratings and sentiment are not policy violations/,
    );
    assert.throws(
      () => assertModerationReasonAllowed(action, "AUTOMATED_SAFETY_CLEAR"),
      /cannot justify/,
    );
  }

  assert.doesNotThrow(() => assertModerationReasonAllowed("PUBLISH", "ROUTINE_LOW_RATING_REVIEW"));
  assert.doesNotThrow(() => assertModerationReasonAllowed("HOLD", "ROUTINE_LOW_RATING_REVIEW"));
  assert.doesNotThrow(() => assertModerationReasonAllowed("UPHOLD", "AUTOMATED_SAFETY_CLEAR"));
});

test("requires a concrete policy reason for final adverse decisions", () => {
  for (const action of ["REJECT", "REMOVE"] as const) {
    assert.throws(() => assertModerationReasonAllowed(action, "AUTOMATED_SAFETY_SIGNAL"), /cannot justify/);
    assert.throws(() => assertModerationReasonAllowed(action, "OTHER_POLICY"), /cannot justify/);
    assert.doesNotThrow(() => assertModerationReasonAllowed(action, "PII"));
    assert.doesNotThrow(() => assertModerationReasonAllowed(action, "MANIPULATION"));
    assert.doesNotThrow(() => assertModerationReasonAllowed(action, "FACTUALLY_CONTRADICTED"));
  }
});

test("requires documented Pin&Go evidence for adverse moderation actions", () => {
  assert.throws(() => requireModerationEvidence("HOLD", "OTHER_POLICY", "too short", {}), /documented evidence summary/);
  assert.throws(() => requireModerationEvidence("REMOVE", "SPAM", "too short", {}), /documented evidence summary/);
  assert.throws(() => requireModerationEvidence("REJECT", "FACTUALLY_CONTRADICTED", "Delivery logs contradict the allegation.", null), /structured positive Pin&Go evidence/);
  assert.throws(() => requireModerationEvidence("REJECT", "FACTUALLY_CONTRADICTED", "Delivery logs contradict the allegation.", {
    kind: "PIN_GO_REVIEW_MODERATION_EVIDENCE",
    referenceId: null,
    selectedReference: null,
  }), /structured positive Pin&Go evidence reference/);
  assert.doesNotThrow(() => requireModerationEvidence("REJECT", "FACTUALLY_CONTRADICTED", "Delivery logs contradict the allegation.", {
    kind: "PIN_GO_REVIEW_MODERATION_EVIDENCE",
    referenceId: "log_1",
    selectedReference: { type: "COMMUNICATION", record: { id: "log_1", status: "SENT" } },
  }));

  // Publishing and upholding are not adverse actions, so the evidence-note gate
  // does not manufacture a reason to suppress a legitimate review.
  assert.doesNotThrow(() => requireModerationEvidence("PUBLISH", "OTHER_POLICY", null, null));
  assert.doesNotThrow(() => requireModerationEvidence("UPHOLD", "OTHER_POLICY", null, null));
});

test("enforces the host-response moderation state machine", () => {
  assert.doesNotThrow(() => assertResponseModerationTransition("PUBLISHED", "HOLD"));
  assert.doesNotThrow(() => assertResponseModerationTransition("HELD_FOR_REVIEW", "PUBLISH"));
  assert.doesNotThrow(() => assertResponseModerationTransition("HELD_FOR_REVIEW", "REMOVE"));
  assert.doesNotThrow(() => assertResponseModerationTransition("REMOVED", "HOLD"));

  assert.throws(() => assertResponseModerationTransition("PUBLISHED", "REMOVE"), /Cannot remove/);
  assert.throws(() => assertResponseModerationTransition("PUBLISHED", "PUBLISH"), /Cannot publish/);
  assert.throws(() => assertResponseModerationTransition("REMOVED", "PUBLISH"), /Cannot publish/);
  assert.throws(() => assertResponseModerationTransition("HELD_FOR_REVIEW", "HOLD"), /Cannot hold/);
});

test("host-response decisions require an objective reason and documented note", () => {
  const note = "The response body was reviewed against the content policy.";
  assert.doesNotThrow(() => requireResponseModerationDecision("PUBLISH", "AUTOMATED_SAFETY_CLEAR", note));
  assert.doesNotThrow(() => requireResponseModerationDecision("HOLD", "AUTOMATED_SAFETY_SIGNAL", note));
  assert.doesNotThrow(() => requireResponseModerationDecision("REMOVE", "PII", note));

  assert.throws(() => requireResponseModerationDecision("PUBLISH", "OTHER_POLICY", note), /cannot justify publish/);
  assert.throws(() => requireResponseModerationDecision("HOLD", "ROUTINE_LOW_RATING_REVIEW", note), /cannot justify hold/);
  assert.throws(() => requireResponseModerationDecision("REMOVE", "AUTOMATED_SAFETY_SIGNAL", note), /cannot justify remove/);
  assert.throws(() => requireResponseModerationDecision("REMOVE", "SPAM", "too short"), /at least 20 characters/);
});
