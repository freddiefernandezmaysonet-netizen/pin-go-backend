import { createHash } from "node:crypto";

import {
  GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
  GUEST_JOURNEY_COORDINATION_INTENT_TYPES,
  GUEST_JOURNEY_TARGET_ENGINES,
} from "./guest-journey-contract";

import type {
  GuestJourneyCoordinationIntentType,
  GuestJourneyTargetEngine,
  ProposedJourneyCoordinationIntent,
} from "./guest-journey-contract";

const SAFE_PAYLOAD_KEYS = new Set([
  "messageLogId",
  "communicationType",
  "channel",
]);

function requireText(
  value: string,
  fieldName: string
): string {
  const cleanValue = String(value ?? "").trim();

  if (!cleanValue) {
    throw new Error(
      `GUEST_JOURNEY_COORDINATION_${fieldName.toUpperCase()}_REQUIRED`
    );
  }

  return cleanValue;
}

function requireSafeIdentifier(
  value: unknown,
  fieldName: string
): string {
  const cleanValue = String(value ?? "")
    .trim()
    .toUpperCase();

  if (
    !cleanValue ||
    cleanValue.length > 80 ||
    !/^[A-Z0-9_]+$/.test(cleanValue)
  ) {
    throw new Error(
      `GUEST_JOURNEY_COORDINATION_PAYLOAD_${fieldName.toUpperCase()}_INVALID`
    );
  }

  return cleanValue;
}

function requireSafeOpaqueId(
  value: unknown,
  fieldName: string
): string {
  const cleanValue = String(value ?? "").trim();
  if (
    !cleanValue ||
    cleanValue.length > 191 ||
    !/^[A-Za-z0-9_-]+$/.test(cleanValue)
  ) {
    throw new Error(
      `GUEST_JOURNEY_COORDINATION_PAYLOAD_${fieldName.toUpperCase()}_INVALID`
    );
  }
  return cleanValue;
}

function requireSafeCode(
  value: string,
  fieldName: string
): string {
  const cleanValue = String(value ?? "")
    .trim()
    .toUpperCase();

  if (
    !cleanValue ||
    cleanValue.length > 120 ||
    !/^[A-Z0-9_]+$/.test(cleanValue)
  ) {
    throw new Error(
      `GUEST_JOURNEY_COORDINATION_${fieldName.toUpperCase()}_INVALID`
    );
  }

  return cleanValue;
}

function requireEvidenceFingerprint(
  value: string
): string {
  const cleanValue = String(value ?? "")
    .trim()
    .toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(cleanValue)) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_EVIDENCE_FINGERPRINT_INVALID"
    );
  }

  return cleanValue;
}

export function normalizeGuestJourneyCoordinationPayload(
  intentType:
    GuestJourneyCoordinationIntentType,
  payload:
    Record<string, unknown> | undefined
): Record<string, string> | null {
  const source = payload ?? {};
  const keys = Object.keys(source).sort();

  for (const key of keys) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) {
      throw new Error(
        `GUEST_JOURNEY_COORDINATION_PAYLOAD_KEY_FORBIDDEN:${key}`
      );
    }
  }

  const communicationIntent =
    intentType === "REQUEST_COMMUNICATION" ||
    intentType ===
      "REQUEST_COMMUNICATION_RETRY";

  if (!communicationIntent) {
    if (keys.length > 0) {
      throw new Error(
        "GUEST_JOURNEY_COORDINATION_PAYLOAD_NOT_ALLOWED"
      );
    }

    return null;
  }

  if (keys.length === 0) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_COMMUNICATION_PAYLOAD_REQUIRED"
    );
  }

  if (
    (keys.length !== 2 && keys.length !== 3) ||
    !keys.includes("communicationType") ||
    !keys.includes("channel") ||
    (keys.length === 3 && !keys.includes("messageLogId"))
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_COMMUNICATION_PAYLOAD_INCOMPLETE"
    );
  }

  return {
    ...(source.messageLogId !== undefined && source.messageLogId !== null
      ? {
          messageLogId: requireSafeOpaqueId(
            source.messageLogId,
            "messageLogId"
          ),
        }
      : {}),
    communicationType:
      requireSafeIdentifier(
        source.communicationType,
        "communication_type"
      ),
    channel: requireSafeIdentifier(
      source.channel,
      "channel"
    ),
  };
}

export type GuestJourneyCoordinationIntentIdentity = {
  reservationId: string;
  evidenceFingerprint: string;
  intentType:
    GuestJourneyCoordinationIntentType;
  targetEngine: GuestJourneyTargetEngine;
  reasonCode: string;
  expectedOutcomeCode: string;
  payload?: Record<string, unknown>;
};

export function buildGuestJourneyCoordinationIntentKey(
  input:
    GuestJourneyCoordinationIntentIdentity
): string {
  const reservationId = requireText(
    input.reservationId,
    "reservation_id"
  );
  const evidenceFingerprint =
    requireEvidenceFingerprint(
      input.evidenceFingerprint
    );

  if (
    !GUEST_JOURNEY_COORDINATION_INTENT_TYPES
      .includes(input.intentType)
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_INTENT_TYPE_INVALID"
    );
  }

  if (
    !GUEST_JOURNEY_TARGET_ENGINES
      .includes(input.targetEngine)
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_TARGET_ENGINE_INVALID"
    );
  }

  const intentType = input.intentType;
  const targetEngine = input.targetEngine;
  const reasonCode = requireSafeCode(
    input.reasonCode,
    "reason_code"
  );
  const expectedOutcomeCode =
    requireSafeCode(
      input.expectedOutcomeCode,
      "expected_outcome_code"
    );
  const payload =
    normalizeGuestJourneyCoordinationPayload(
      input.intentType,
      input.payload
    );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion:
          GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
        reservationId,
        evidenceFingerprint,
        intentType,
        targetEngine,
        reasonCode,
        expectedOutcomeCode,
        payload,
      })
    )
    .digest("hex");

  return [
    "guest-journey",
    "coordination-intent",
    GUEST_JOURNEY_COORDINATION_INTENT_VERSION,
    reservationId,
    digest,
  ].join(":");
}

export function buildGuestJourneyCoordinationIntentKeyFromProposal(
  reservationId: string,
  evidenceFingerprint: string,
  intent: ProposedJourneyCoordinationIntent
): string {
  return buildGuestJourneyCoordinationIntentKey({
    reservationId,
    evidenceFingerprint,
    ...intent,
  });
}
