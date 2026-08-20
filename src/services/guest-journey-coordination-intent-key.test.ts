import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGuestJourneyCoordinationIntentKey,
  normalizeGuestJourneyCoordinationPayload,
} from "./guest-journey-coordination-intent-key";

const BASE = {
  reservationId: "reservation-1",
  evidenceFingerprint:
    "a".repeat(64),
  intentType:
    "REQUEST_COMMUNICATION_RETRY" as const,
  targetEngine:
    "COMMUNICATIONS" as const,
  reasonCode:
    "COMMUNICATION_DELIVERY_FAILED",
  expectedOutcomeCode:
    "COMMUNICATION_DELIVERY_FINAL",
};

test(
  "builds a stable key from normalized communication semantics",
  () => {
    const first =
      buildGuestJourneyCoordinationIntentKey({
        ...BASE,
        payload: {
          communicationType:
            "precheckin_invitation",
          channel: "email",
        },
      });
    const second =
      buildGuestJourneyCoordinationIntentKey({
        ...BASE,
        payload: {
          channel: " EMAIL ",
          communicationType:
            " PRECHECKIN_INVITATION ",
        },
      });

    assert.equal(first, second);
    assert.match(
      first,
      /^guest-journey:coordination-intent:guest_journey_coordination_intent_v1:reservation-1:[a-f0-9]{64}$/
    );
  }
);

test(
  "keeps distinct communication retries distinct",
  () => {
    const email =
      buildGuestJourneyCoordinationIntentKey({
        ...BASE,
        payload: {
          communicationType:
            "PRECHECKIN_INVITATION",
          channel: "EMAIL",
        },
      });
    const sms =
      buildGuestJourneyCoordinationIntentKey({
        ...BASE,
        payload: {
          communicationType:
            "PRECHECKIN_INVITATION",
          channel: "SMS",
        },
      });

    assert.notEqual(email, sms);
  }
);

test(
  "allows no payload for non-communication intents",
  () => {
    assert.equal(
      normalizeGuestJourneyCoordinationPayload(
        "REQUEST_ACCESS_EVALUATION",
        undefined
      ),
      null
    );

    assert.throws(
      () =>
        normalizeGuestJourneyCoordinationPayload(
          "REQUEST_ACCESS_EVALUATION",
          {
            channel: "EMAIL",
          }
        ),
      /PAYLOAD_NOT_ALLOWED/
    );
  }
);

test(
  "rejects payload fields that could carry secrets or guest data",
  () => {
    assert.throws(
      () =>
        normalizeGuestJourneyCoordinationPayload(
          "REQUEST_COMMUNICATION_RETRY",
          {
            communicationType:
              "ACCESS_READY",
            channel: "EMAIL",
            messageBody:
              "private message",
          }
        ),
      /PAYLOAD_KEY_FORBIDDEN:messageBody/
    );

    assert.throws(
      () =>
        normalizeGuestJourneyCoordinationPayload(
          "REQUEST_COMMUNICATION_RETRY",
          {
            communicationType:
              "ACCESS_READY",
          }
        ),
      /COMMUNICATION_PAYLOAD_INCOMPLETE/
    );
  }
);

test(
  "rejects malformed fingerprints and noncanonical codes before persistence",
  () => {
    assert.throws(
      () =>
        buildGuestJourneyCoordinationIntentKey({
          ...BASE,
          evidenceFingerprint:
            "not-a-sha256",
        }),
      /EVIDENCE_FINGERPRINT_INVALID/
    );

    assert.throws(
      () =>
        buildGuestJourneyCoordinationIntentKey({
          ...BASE,
          reasonCode:
            "contains guest@email.test",
        }),
      /REASON_CODE_INVALID/
    );
  }
);
