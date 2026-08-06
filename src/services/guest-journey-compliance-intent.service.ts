import {
  Prisma,
  PrismaClient,
} from "@prisma/client";

import {
  buildCancellationPolicySnapshot,
} from "./cancellation-policy.service";

import {
  ensureReservationGuestAgreementSnapshot,
} from "./guest-agreement.service";

import {
  claimGuestJourneyCoordinationIntent,
  markGuestJourneyCoordinationIntentExhausted,
  markGuestJourneyCoordinationIntentWaitingForEvidence,
} from "./guest-journey-coordination-intent.service";

import type {
  GuestJourneyCoordinationIntentSnapshot,
} from "./guest-journey-contract";

/**
 * Guest Journey -> Compliance owner integration V1.
 *
 * Supported intents:
 *
 * REQUEST_REQUIREMENTS_SNAPSHOT
 *   Autonomous Compliance work:
 *   - capture missing Guest Agreement snapshot;
 *   - capture missing Cancellation Policy snapshot;
 *   - then WAIT_FOR_EVIDENCE so the Reconciler verifies persisted outcome.
 *
 * REQUEST_GUEST_VERIFICATION
 *   Human-gated Compliance work:
 *   - claim the intent;
 *   - do NOT fabricate legal acceptance, rules acceptance,
 *     identity consent, legal name or return URL;
 *   - do NOT call Stripe Identity here;
 *   - move to WAITING_FOR_EVIDENCE while the existing guest portal
 *     produces canonical persisted evidence.
 *
 * This owner integration never marks success from a returned "ok".
 * SUCCEEDED is reserved for Reconciler verification of persisted evidence.
 */

const COMPLIANCE_TARGET_ENGINE =
  "Compliance" as const;

export type GuestJourneyComplianceIntentOutcome =
  | "CLAIM_NOT_ACQUIRED"
  | "WAITING_FOR_EVIDENCE"
  | "EXHAUSTED";

export type GuestJourneyComplianceIntentResult = {
  intentId: string;

  reservationId:
    | string
    | null;

  claimed:
    boolean;

  outcome:
    GuestJourneyComplianceIntentOutcome;

  intent:
    GuestJourneyCoordinationIntentSnapshot;

  workPerformed: string[];

  exhaustedReason:
    | string
    | null;
};

export type GuestJourneyComplianceIntentDependencies = {
  ensureAgreementSnapshot?:
    typeof ensureReservationGuestAgreementSnapshot;

  buildCancellationSnapshot?:
    typeof buildCancellationPolicySnapshot;
};

function requireNonEmpty(
  value: string,
  fieldName: string
): string {
  const cleanValue =
    value.trim();

  if (!cleanValue) {
    throw new Error(
      `${fieldName} is required`
    );
  }

  return cleanValue;
}

function requireValidDate(
  value: Date,
  fieldName: string
): Date {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime())
  ) {
    throw new Error(
      `${fieldName} must be a valid Date`
    );
  }

  return value;
}

function readJsonObject(
  value: unknown
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as
    Record<string, unknown>;
}

function readNonEmptyString(
  value: unknown
): string | null {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const cleanValue =
    value.trim();

  return cleanValue
    ? cleanValue
    : null;
}

function isValidGuestAgreementSnapshot(
  value: unknown
): boolean {
  const snapshot =
    readJsonObject(value);

  if (!snapshot) {
    return false;
  }

  return Boolean(
    readNonEmptyString(
      snapshot.agreementId
    ) &&
    readNonEmptyString(
      snapshot.propertyId
    ) &&
    readNonEmptyString(
      snapshot.version
    ) &&
    readNonEmptyString(
      snapshot.title
    ) &&
    readNonEmptyString(
      snapshot.agreementText
    ) &&
    readNonEmptyString(
      snapshot.capturedAt
    ) &&
    typeof snapshot
      .requiresIdentityVerification ===
      "boolean" &&
    typeof snapshot
      .requiresAgreementSignature ===
      "boolean"
  );
}

function isNonEmptyJsonObject(
  value: unknown
): boolean {
  const object =
    readJsonObject(value);

  return Boolean(
    object &&
    Object.keys(object).length > 0
  );
}

async function exhaustClaimedIntent(
  prisma: PrismaClient,
  input: {
    intentId: string;
    leaseToken: string;
    now: Date;
    reason: string;
  }
): Promise<
  GuestJourneyCoordinationIntentSnapshot
> {
  const result =
    await markGuestJourneyCoordinationIntentExhausted(
      prisma,
      {
        intentId:
          input.intentId,

        leaseToken:
          input.leaseToken,

        now:
          input.now,

        lastError:
          input.reason,
      }
    );

  return result.intent;
}

async function moveClaimedIntentToWaiting(
  prisma: PrismaClient,
  input: {
    intentId: string;
    leaseToken: string;
    now: Date;
  }
): Promise<
  GuestJourneyCoordinationIntentSnapshot
> {
  const result =
    await markGuestJourneyCoordinationIntentWaitingForEvidence(
      prisma,
      {
        intentId:
          input.intentId,

        leaseToken:
          input.leaseToken,

        now:
          input.now,
      }
    );

  if (!result.transitioned) {
    throw new Error(
      "GUEST_JOURNEY_COMPLIANCE_WAITING_TRANSITION_LOST"
    );
  }

  return result.intent;
}

async function ensureRequirementsSnapshots(
  prisma: PrismaClient,
  reservationId: string,
  dependencies:
    GuestJourneyComplianceIntentDependencies
): Promise<{
  ok: true;
  workPerformed: string[];
} | {
  ok: false;
  reason: string;
  workPerformed: string[];
}> {
  const ensureAgreementSnapshot =
    dependencies
      .ensureAgreementSnapshot ??
    ensureReservationGuestAgreementSnapshot;

  const buildCancellationSnapshot =
    dependencies
      .buildCancellationSnapshot ??
    buildCancellationPolicySnapshot;

  const workPerformed:
    string[] = [];

  let reservation =
    await prisma.reservation
      .findUnique({
        where: {
          id:
            reservationId,
        },

        select: {
          id: true,
          propertyId: true,

          guestAgreementSnapshot:
            true,

          cancellationPolicySnapshot:
            true,
        },
      });

  if (!reservation) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_RESERVATION_NOT_FOUND",

      workPerformed,
    };
  }

  /*
   * Existing legal evidence is immutable.
   * If a non-null agreement snapshot exists but is malformed,
   * Compliance must not silently replace it with today's agreement.
   */
  if (
    reservation
      .guestAgreementSnapshot !==
      null &&
    reservation
      .guestAgreementSnapshot !==
      undefined &&
    !isValidGuestAgreementSnapshot(
      reservation
        .guestAgreementSnapshot
    )
  ) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_EXISTING_AGREEMENT_SNAPSHOT_INVALID",

      workPerformed,
    };
  }

  if (
    reservation
      .guestAgreementSnapshot ===
      null ||
    reservation
      .guestAgreementSnapshot ===
      undefined
  ) {
    const agreementResult =
      await ensureAgreementSnapshot(
        prisma,
        reservationId
      );

    if (!agreementResult.ok) {
      return {
        ok: false,

        reason:
          agreementResult.reason ??
          "GUEST_JOURNEY_COMPLIANCE_AGREEMENT_SNAPSHOT_FAILED",

        workPerformed,
      };
    }

    if (
      !agreementResult
        .alreadyCaptured
    ) {
      workPerformed.push(
        "GUEST_AGREEMENT_SNAPSHOT_CAPTURED"
      );
    }
  }

  /*
   * Re-read before Cancellation Policy work so this owner integration
   * verifies persisted state rather than trusting the previous function
   * return value.
   */
  reservation =
    await prisma.reservation
      .findUnique({
        where: {
          id:
            reservationId,
        },

        select: {
          id: true,
          propertyId: true,

          guestAgreementSnapshot:
            true,

          cancellationPolicySnapshot:
            true,
        },
      });

  if (!reservation) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_RESERVATION_NOT_FOUND_AFTER_AGREEMENT",

      workPerformed,
    };
  }

  if (
    !isValidGuestAgreementSnapshot(
      reservation
        .guestAgreementSnapshot
    )
  ) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_AGREEMENT_SNAPSHOT_NOT_PERSISTED",

      workPerformed,
    };
  }

  /*
   * A non-null but empty/malformed Cancellation Policy snapshot must
   * not be overwritten silently. It is legal evidence requiring
   * explicit escalation in a later capability.
   */
  if (
    reservation
      .cancellationPolicySnapshot !==
      null &&
    reservation
      .cancellationPolicySnapshot !==
      undefined &&
    !isNonEmptyJsonObject(
      reservation
        .cancellationPolicySnapshot
    )
  ) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_EXISTING_CANCELLATION_SNAPSHOT_INVALID",

      workPerformed,
    };
  }

  if (
    reservation
      .cancellationPolicySnapshot ===
      null ||
    reservation
      .cancellationPolicySnapshot ===
      undefined
  ) {
    const cancellationSnapshot =
      await buildCancellationSnapshot(
        reservation.propertyId
      );

    /*
     * Compare-and-set: never overwrite a cancellation snapshot that
     * another canonical flow persisted after our read.
     */
    const updateResult =
      await prisma.reservation
        .updateMany({
          where: {
            id:
              reservation.id,

            cancellationPolicySnapshot: {
              equals:
                Prisma.DbNull,
            },
          },

          data: {
            cancellationPolicyId:
              cancellationSnapshot
                .policyId,

            cancellationPolicySnapshot:
              cancellationSnapshot as unknown as
                Prisma.InputJsonValue,
          },
        });

    if (
      updateResult.count === 1
    ) {
      workPerformed.push(
        "CANCELLATION_POLICY_SNAPSHOT_CAPTURED"
      );
    }
  }

  /*
   * Final persisted-evidence verification before handing control
   * back to the Reconciler.
   */
  const finalReservation =
    await prisma.reservation
      .findUnique({
        where: {
          id:
            reservationId,
        },

        select: {
          guestAgreementSnapshot:
            true,

          cancellationPolicySnapshot:
            true,
        },
      });

  if (!finalReservation) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_RESERVATION_NOT_FOUND_AFTER_SNAPSHOT_WORK",

      workPerformed,
    };
  }

  if (
    !isValidGuestAgreementSnapshot(
      finalReservation
        .guestAgreementSnapshot
    )
  ) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_AGREEMENT_SNAPSHOT_NOT_PERSISTED",

      workPerformed,
    };
  }

  if (
    !isNonEmptyJsonObject(
      finalReservation
        .cancellationPolicySnapshot
    )
  ) {
    return {
      ok: false,

      reason:
        "GUEST_JOURNEY_COMPLIANCE_CANCELLATION_SNAPSHOT_NOT_PERSISTED",

      workPerformed,
    };
  }

  return {
    ok: true,
    workPerformed,
  };
}

export async function processGuestJourneyComplianceIntent(
  prisma: PrismaClient,
  input: {
    intentId: string;
    now?: Date;
    leaseDurationMs?: number;
  },
  dependencies:
    GuestJourneyComplianceIntentDependencies = {}
): Promise<
  GuestJourneyComplianceIntentResult
> {
  const intentId =
    requireNonEmpty(
      input.intentId,
      "intentId"
    );

  const now =
    requireValidDate(
      input.now ??
        new Date(),
      "now"
    );

  const claimResult =
    await claimGuestJourneyCoordinationIntent(
      prisma,
      {
        intentId,

        targetEngine:
          COMPLIANCE_TARGET_ENGINE,

        now,

        leaseDurationMs:
          input
            .leaseDurationMs,
      }
    );

  if (
    !claimResult.claimed ||
    !claimResult.leaseToken
  ) {
    return {
      intentId,

      reservationId:
        null,

      claimed:
        false,

      outcome:
        "CLAIM_NOT_ACQUIRED",

      intent:
        claimResult.intent,

      workPerformed:
        [],

      exhaustedReason:
        null,
    };
  }

  const leaseToken =
    claimResult.leaseToken;

  const intentRecord =
    await prisma
      .guestJourneyCoordinationIntent
      .findUnique({
        where: {
          id:
            intentId,
        },

        select: {
          id: true,
          reservationId: true,
          intentType: true,
          targetEngine: true,
        },
      });

  if (!intentRecord) {
    throw new Error(
      "GUEST_JOURNEY_COMPLIANCE_INTENT_NOT_FOUND_AFTER_CLAIM"
    );
  }

  if (
    intentRecord
      .targetEngine !==
    COMPLIANCE_TARGET_ENGINE
  ) {
    const reason =
      "GUEST_JOURNEY_COMPLIANCE_TARGET_ENGINE_MISMATCH";

    const exhaustedIntent =
      await exhaustClaimedIntent(
        prisma,
        {
          intentId,
          leaseToken,
          now,
          reason,
        }
      );

    return {
      intentId,

      reservationId:
        intentRecord
          .reservationId,

      claimed:
        true,

      outcome:
        "EXHAUSTED",

      intent:
        exhaustedIntent,

      workPerformed:
        [],

      exhaustedReason:
        reason,
    };
  }

  switch (
    intentRecord.intentType
  ) {
    case "REQUEST_REQUIREMENTS_SNAPSHOT": {
      const result =
        await ensureRequirementsSnapshots(
          prisma,
          intentRecord
            .reservationId,
          dependencies
        );

      if (!result.ok) {
        const exhaustedIntent =
          await exhaustClaimedIntent(
            prisma,
            {
              intentId,
              leaseToken,
              now,

              reason:
                result.reason,
            }
          );

        return {
          intentId,

          reservationId:
            intentRecord
              .reservationId,

          claimed:
            true,

          outcome:
            "EXHAUSTED",

          intent:
            exhaustedIntent,

          workPerformed:
            result
              .workPerformed,

          exhaustedReason:
            result.reason,
        };
      }

      const waitingIntent =
        await moveClaimedIntentToWaiting(
          prisma,
          {
            intentId,
            leaseToken,
            now,
          }
        );

      return {
        intentId,

        reservationId:
          intentRecord
            .reservationId,

        claimed:
          true,

        outcome:
          "WAITING_FOR_EVIDENCE",

        intent:
          waitingIntent,

        workPerformed:
          result
            .workPerformed,

        exhaustedReason:
          null,
      };
    }

    case "REQUEST_GUEST_VERIFICATION": {
      /*
       * Intentionally no Stripe call here.
       *
       * Guest agreement/rules acceptance, identity consent,
       * declared legal name and return URL originate from the
       * guest-facing interaction. Compliance waits for that
       * canonical evidence instead of fabricating it.
       */
      const waitingIntent =
        await moveClaimedIntentToWaiting(
          prisma,
          {
            intentId,
            leaseToken,
            now,
          }
        );

      return {
        intentId,

        reservationId:
          intentRecord
            .reservationId,

        claimed:
          true,

        outcome:
          "WAITING_FOR_EVIDENCE",

        intent:
          waitingIntent,

        workPerformed: [
          "GUEST_VERIFICATION_AWAITING_GUEST_EVIDENCE",
        ],

        exhaustedReason:
          null,
      };
    }

    default: {
      const reason =
        `GUEST_JOURNEY_COMPLIANCE_UNSUPPORTED_INTENT_TYPE:${intentRecord.intentType}`;

      const exhaustedIntent =
        await exhaustClaimedIntent(
          prisma,
          {
            intentId,
            leaseToken,
            now,
            reason,
          }
        );

      return {
        intentId,

        reservationId:
          intentRecord
            .reservationId,

        claimed:
          true,

        outcome:
          "EXHAUSTED",

        intent:
          exhaustedIntent,

        workPerformed:
          [],

        exhaustedReason:
          reason,
      };
    }
  }
}