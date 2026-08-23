import {
  createHash,
} from "node:crypto";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import type { AuditEntry } from "../apms/audit-types";
import {
  persistAuditEntry,
} from "../apms/audit-persistence.service";
import {
  GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
  GUEST_JOURNEY_OWNER_RUNTIME_VERSION,
} from "./guest-journey-contract";

export const GUEST_JOURNEY_ACCESS_EVALUATION_TARGET = {
  targetEngine: "ACCESS",
  intentType: "REQUEST_ACCESS_EVALUATION",
  expectedOutcomeCode:
    "ACCESS_RELEASE_STATUS_ELIGIBLE",
  handlerCode:
    GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
} as const;

const MAX_ERROR_DETAIL_LENGTH = 8_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

type OwnerRuntimeTransactionClient = Pick<
  Prisma.TransactionClient,
  | "guestJourneyCoordinationIntent"
  | "guestJourneyCoordinationIntentAttempt"
  | "apmsAuditEntry"
>;

export type GuestJourneyOwnerRuntimeDb = {
  $transaction<T>(
    callback: (
      tx: OwnerRuntimeTransactionClient
    ) => Promise<T>,
    options?: {
      isolationLevel?: "Serializable";
    }
  ): Promise<T>;
};

export type GuestJourneyOwnerRuntimeScope = {
  organizationIds: string[];
  propertyIds: string[];
};

export type ClaimedAccessEvaluationIntent = {
  intentId: string;
  intentKey: string;
  reservationId: string;
  journeyId: string;
  organizationId: string;
  propertyId: string;
  targetEngine: "ACCESS";
  intentType:
    "REQUEST_ACCESS_EVALUATION";
  expectedOutcomeCode:
    "ACCESS_RELEASE_STATUS_ELIGIBLE";
  inputEvidenceFingerprint: string;
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type ClaimAccessEvaluationResult =
  | {
      claimed: true;
      recoveredStaleLease: boolean;
      claim: ClaimedAccessEvaluationIntent;
    }
  | {
      claimed: false;
      reason:
        | "NOT_FOUND"
        | "NOT_ELIGIBLE"
        | "NOT_DUE"
        | "LIVE_LEASE"
        | "CLAIM_RACE"
        | "EXHAUSTED";
    };

export type AccessEvaluationCompletion =
  | {
      kind: "SUCCEEDED";
      outcomeEvidenceFingerprint: string;
    }
  | {
      kind: "WAITING_FOR_EVIDENCE";
      outcomeEvidenceFingerprint: string;
      errorCode: string;
      errorDetail: string;
    }
  | {
      kind: "RETRYABLE";
      outcomeEvidenceFingerprint?: string;
      errorCode: string;
      errorDetail: string;
    };

export type CompleteAccessEvaluationResult = {
  intentId: string;
  attemptNumber: number;
  status:
    | "SUCCEEDED"
    | "WAITING_FOR_EVIDENCE"
    | "RETRYABLE"
    | "EXHAUSTED";
  nextActionAt: Date | null;
};

function requireText(
  value: unknown,
  errorCode: string
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function requireValidDate(
  value: Date,
  errorCode: string
): Date {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function requirePositiveInteger(
  value: number,
  errorCode: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(errorCode);
  }

  return value;
}

function truncateErrorDetail(
  value: unknown
): string {
  return String(value ?? "")
    .replace(
      /:\/\/[^\s/@:]+:[^\s/@]+@/g,
      "://[REDACTED]@"
    )
    .replace(
      /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]"
    )
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .slice(0, MAX_ERROR_DETAIL_LENGTH);
}

function fingerprintLeaseToken(
  leaseToken: string
): string {
  return createHash("sha256")
    .update(leaseToken)
    .digest("hex");
}

function scopeAllows(input: {
  organizationId: string;
  propertyId: string;
  scope: GuestJourneyOwnerRuntimeScope;
}): boolean {
  return (
    input.scope.organizationIds.includes(
      input.organizationId
    ) ||
    input.scope.propertyIds.includes(
      input.propertyId
    )
  );
}

function calculateRetryAt(input: {
  attemptNumber: number;
  retryBaseMs: number;
  now: Date;
}): Date {
  const exponentialDelay =
    input.retryBaseMs *
    2 ** Math.max(0, input.attemptNumber - 1);
  const delay = Math.min(
    exponentialDelay,
    MAX_RETRY_DELAY_MS
  );

  return new Date(
    input.now.getTime() + delay
  );
}

function buildRuntimeAudit(input: {
  action:
    | "CLAIMED"
    | "LEASE_EXPIRED"
    | "SUCCEEDED"
    | "WAITING_FOR_EVIDENCE"
    | "RETRYABLE"
    | "EXHAUSTED";
  intentId: string;
  intentKey: string;
  reservationId: string;
  organizationId: string;
  propertyId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date;
  inputEvidenceFingerprint: string;
  outcomeEvidenceFingerprint?:
    | string
    | null;
  leaseTokenFingerprint: string;
  errorCode?: string | null;
}): AuditEntry {
  const success =
    input.action === "CLAIMED" ||
    input.action === "SUCCEEDED" ||
    input.action ===
      "WAITING_FOR_EVIDENCE";

  return {
    engine: "ACCESS",
    decisionId: [
      "guest-journey",
      "owner-runtime",
      input.intentId,
      input.attemptNumber,
      input.action.toLowerCase(),
    ].join(":"),
    entityType: "RESERVATION",
    entityId: input.reservationId,
    eventType:
      input.action === "CLAIMED"
        ? "ACTION_STARTED"
        : success
          ? "ACTION_COMPLETED"
          : "ACTION_FAILED",
    status: success ? "SUCCESS" : "FAILED",
    severity:
      input.action === "EXHAUSTED"
        ? "CRITICAL"
        : input.action === "RETRYABLE" ||
            input.action === "LEASE_EXPIRED"
          ? "WARNING"
          : "INFO",
    summary:
      `Guest Journey ACCESS evaluation attempt ${input.attemptNumber} ${input.action.toLowerCase().replaceAll("_", " ")}.`,
    reason:
      input.errorCode ??
      "Owner Engine runtime transition was fenced by the active lease and persisted with attempt evidence.",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(
      0,
      input.completedAt.getTime() -
        input.startedAt.getTime()
    ),
    metadata: {
      runtime:
        GUEST_JOURNEY_OWNER_RUNTIME_VERSION,
      handlerCode:
        GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE,
      intentId: input.intentId,
      intentKey: input.intentKey,
      attemptNumber:
        input.attemptNumber,
      organizationId:
        input.organizationId,
      propertyId: input.propertyId,
      reservationId:
        input.reservationId,
      inputEvidenceFingerprint:
        input.inputEvidenceFingerprint,
      outcomeEvidenceFingerprint:
        input.outcomeEvidenceFingerprint ??
        null,
      leaseTokenFingerprint:
        input.leaseTokenFingerprint,
      errorCode:
        input.errorCode ?? null,
      externalSideEffectsEnabled:
        false,
    },
  };
}

type IntentSnapshot = {
  id: string;
  intentKey: string;
  reservationId: string;
  journeyId: string;
  intentType: string;
  targetEngine: string;
  expectedOutcomeCode: string;
  evidenceFingerprint: string;
  status:
    GuestJourneyCoordinationIntentStatus;
  claimCount: number;
  leaseToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  nextActionAt: Date | null;
  reservation: {
    propertyId: string;
    property: {
      organizationId: string;
    };
  };
};

function assertCanonicalAccessEvaluation(
  intent: IntentSnapshot
): void {
  if (
    intent.targetEngine !==
      GUEST_JOURNEY_ACCESS_EVALUATION_TARGET
        .targetEngine ||
    intent.intentType !==
      GUEST_JOURNEY_ACCESS_EVALUATION_TARGET
        .intentType ||
    intent.expectedOutcomeCode !==
      GUEST_JOURNEY_ACCESS_EVALUATION_TARGET
        .expectedOutcomeCode
  ) {
    throw new Error(
      "GUEST_JOURNEY_OWNER_RUNTIME_HANDLER_CONTRACT_MISMATCH"
    );
  }
}

function snapshotCompareWhere(
  intent: IntentSnapshot
) {
  return {
    id: intent.id,
    status: intent.status,
    claimCount: intent.claimCount,
    leaseToken: intent.leaseToken,
    claimedAt: intent.claimedAt,
    leaseExpiresAt:
      intent.leaseExpiresAt,
    nextActionAt:
      intent.nextActionAt,
  };
}

async function persistExhaustion(input: {
  tx: OwnerRuntimeTransactionClient;
  intent: IntentSnapshot;
  now: Date;
  leaseTokenFingerprint: string;
  errorCode: string;
}): Promise<boolean> {
  const exhausted =
    await input.tx
      .guestJourneyCoordinationIntent
      .updateMany({
        where: snapshotCompareWhere(
          input.intent
        ),
        data: {
          status:
            GuestJourneyCoordinationIntentStatus
              .EXHAUSTED,
          leaseToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          nextActionAt: null,
          exhaustedAt: input.now,
          lastError: input.errorCode,
        },
      });

  if (exhausted.count !== 1) {
    return false;
  }

  await persistAuditEntry(
    input.tx,
    buildRuntimeAudit({
      action: "EXHAUSTED",
      intentId: input.intent.id,
      intentKey:
        input.intent.intentKey,
      reservationId:
        input.intent.reservationId,
      organizationId:
        input.intent.reservation
          .property.organizationId,
      propertyId:
        input.intent.reservation
          .propertyId,
      attemptNumber:
        Math.max(
          1,
          input.intent.claimCount
        ),
      startedAt:
        input.intent.claimedAt ??
        input.now,
      completedAt: input.now,
      inputEvidenceFingerprint:
        input.intent
          .evidenceFingerprint,
      leaseTokenFingerprint:
        input.leaseTokenFingerprint,
      errorCode: input.errorCode,
    })
  );

  return true;
}

export async function claimGuestJourneyAccessEvaluationIntent(
  db: GuestJourneyOwnerRuntimeDb,
  input: {
    intentId: string;
    leaseToken: string;
    scope: GuestJourneyOwnerRuntimeScope;
    leaseMs: number;
    maxClaims: number;
    now?: Date;
  }
): Promise<ClaimAccessEvaluationResult> {
  const intentId = requireText(
    input.intentId,
    "GUEST_JOURNEY_OWNER_RUNTIME_INTENT_ID_REQUIRED"
  );
  const leaseToken = requireText(
    input.leaseToken,
    "GUEST_JOURNEY_OWNER_RUNTIME_LEASE_TOKEN_REQUIRED"
  );
  const now = requireValidDate(
    input.now ?? new Date(),
    "GUEST_JOURNEY_OWNER_RUNTIME_NOW_INVALID"
  );
  const leaseMs = requirePositiveInteger(
    input.leaseMs,
    "GUEST_JOURNEY_OWNER_RUNTIME_LEASE_MS_INVALID"
  );
  const maxClaims =
    requirePositiveInteger(
      input.maxClaims,
      "GUEST_JOURNEY_OWNER_RUNTIME_MAX_CLAIMS_INVALID"
    );
  const leaseTokenFingerprint =
    fingerprintLeaseToken(leaseToken);

  return db.$transaction(
    async (tx) => {
      const intent =
        await tx
          .guestJourneyCoordinationIntent
          .findUnique({
            where: { id: intentId },
            select: {
              id: true,
              intentKey: true,
              reservationId: true,
              journeyId: true,
              intentType: true,
              targetEngine: true,
              expectedOutcomeCode: true,
              evidenceFingerprint: true,
              status: true,
              claimCount: true,
              leaseToken: true,
              claimedAt: true,
              leaseExpiresAt: true,
              nextActionAt: true,
              reservation: {
                select: {
                  propertyId: true,
                  property: {
                    select: {
                      organizationId: true,
                    },
                  },
                },
              },
            },
          });

      if (!intent) {
        return {
          claimed: false,
          reason: "NOT_FOUND",
        } as const;
      }

      assertCanonicalAccessEvaluation(
        intent
      );

      const organizationId =
        intent.reservation.property
          .organizationId;
      const propertyId =
        intent.reservation.propertyId;

      if (
        !scopeAllows({
          organizationId,
          propertyId,
          scope: input.scope,
        })
      ) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_SCOPE_MISMATCH"
        );
      }

      const staleLease =
        intent.status ===
          GuestJourneyCoordinationIntentStatus
            .CLAIMED &&
        Boolean(intent.leaseExpiresAt) &&
        intent.leaseExpiresAt!.getTime() <=
          now.getTime();

      if (
        intent.status ===
          GuestJourneyCoordinationIntentStatus
            .CLAIMED &&
        !staleLease
      ) {
        return {
          claimed: false,
          reason: "LIVE_LEASE",
        } as const;
      }

      const claimableStatus =
        intent.status ===
          GuestJourneyCoordinationIntentStatus
            .PENDING ||
        intent.status ===
          GuestJourneyCoordinationIntentStatus
            .RETRYABLE ||
        staleLease;

      if (!claimableStatus) {
        return {
          claimed: false,
          reason: "NOT_ELIGIBLE",
        } as const;
      }

      if (
        !staleLease &&
        intent.nextActionAt &&
        intent.nextActionAt.getTime() >
          now.getTime()
      ) {
        return {
          claimed: false,
          reason: "NOT_DUE",
        } as const;
      }

      if (staleLease) {
        if (
          !intent.leaseToken ||
          !intent.claimedAt ||
          !intent.leaseExpiresAt
        ) {
          throw new Error(
            "GUEST_JOURNEY_OWNER_RUNTIME_STALE_LEASE_MALFORMED"
          );
        }

        const expiredAttempt =
          await tx
            .guestJourneyCoordinationIntentAttempt
            .updateMany({
              where: {
                intentId: intent.id,
                attemptNumber:
                  intent.claimCount,
                outcome:
                  GuestJourneyCoordinationAttemptOutcome
                    .IN_FLIGHT,
                leaseExpiresAt:
                  intent.leaseExpiresAt,
              },
              data: {
                outcome:
                  GuestJourneyCoordinationAttemptOutcome
                    .LEASE_EXPIRED,
                completedAt: now,
                errorCode:
                  "OWNER_RUNTIME_LEASE_EXPIRED",
                errorDetail:
                  "The previous worker did not complete before its fenced lease expired.",
              },
            });

        if (expiredAttempt.count !== 1) {
          throw new Error(
            "GUEST_JOURNEY_OWNER_RUNTIME_STALE_ATTEMPT_EVIDENCE_MISSING"
          );
        }

        await persistAuditEntry(
          tx,
          buildRuntimeAudit({
            action: "LEASE_EXPIRED",
            intentId: intent.id,
            intentKey:
              intent.intentKey,
            reservationId:
              intent.reservationId,
            organizationId,
            propertyId,
            attemptNumber:
              intent.claimCount,
            startedAt:
              intent.claimedAt,
            completedAt: now,
            inputEvidenceFingerprint:
              intent.evidenceFingerprint,
            leaseTokenFingerprint:
              fingerprintLeaseToken(
                intent.leaseToken
              ),
            errorCode:
              "OWNER_RUNTIME_LEASE_EXPIRED",
          })
        );
      }

      if (
        intent.claimCount >= maxClaims
      ) {
        const persisted =
          await persistExhaustion({
            tx,
            intent,
            now,
            leaseTokenFingerprint:
              intent.leaseToken
                ? fingerprintLeaseToken(
                    intent.leaseToken
                  )
                : leaseTokenFingerprint,
            errorCode:
              "OWNER_RUNTIME_CLAIM_BUDGET_EXHAUSTED",
          });

        return {
          claimed: false,
          reason: persisted
            ? "EXHAUSTED"
            : "CLAIM_RACE",
        } as const;
      }

      const attemptNumber =
        intent.claimCount + 1;
      const leaseExpiresAt = new Date(
        now.getTime() + leaseMs
      );
      const claimed =
        await tx
          .guestJourneyCoordinationIntent
          .updateMany({
            where:
              snapshotCompareWhere(
                intent
              ),
            data: {
              status:
                GuestJourneyCoordinationIntentStatus
                  .CLAIMED,
              claimCount:
                attemptNumber,
              leaseToken,
              claimedAt: now,
              leaseExpiresAt,
              lastAttemptAt: now,
              nextActionAt: null,
              succeededAt: null,
              exhaustedAt: null,
              outcomeEvidenceFingerprint:
                null,
              lastError: null,
            },
          });

      if (claimed.count !== 1) {
        return {
          claimed: false,
          reason: "CLAIM_RACE",
        } as const;
      }

      await tx
        .guestJourneyCoordinationIntentAttempt
        .create({
          data: {
            intentId: intent.id,
            attemptNumber,
            targetEngine:
              GUEST_JOURNEY_ACCESS_EVALUATION_TARGET
                .targetEngine,
            intentType:
              GUEST_JOURNEY_ACCESS_EVALUATION_TARGET
                .intentType,
            handlerCode:
              GUEST_JOURNEY_ACCESS_EVALUATION_TARGET
                .handlerCode,
            leaseTokenFingerprint,
            inputEvidenceFingerprint:
              intent.evidenceFingerprint,
            outcome:
              GuestJourneyCoordinationAttemptOutcome
                .IN_FLIGHT,
            startedAt: now,
            leaseExpiresAt,
          },
        });

      await persistAuditEntry(
        tx,
        buildRuntimeAudit({
          action: "CLAIMED",
          intentId: intent.id,
          intentKey: intent.intentKey,
          reservationId:
            intent.reservationId,
          organizationId,
          propertyId,
          attemptNumber,
          startedAt: now,
          completedAt: now,
          inputEvidenceFingerprint:
            intent.evidenceFingerprint,
          leaseTokenFingerprint,
        })
      );

      return {
        claimed: true,
        recoveredStaleLease:
          staleLease,
        claim: {
          intentId: intent.id,
          intentKey: intent.intentKey,
          reservationId:
            intent.reservationId,
          journeyId: intent.journeyId,
          organizationId,
          propertyId,
          targetEngine: "ACCESS",
          intentType:
            "REQUEST_ACCESS_EVALUATION",
          expectedOutcomeCode:
            "ACCESS_RELEASE_STATUS_ELIGIBLE",
          inputEvidenceFingerprint:
            intent.evidenceFingerprint,
          attemptNumber,
          leaseToken,
          leaseExpiresAt,
        },
      } as const;
    },
    {
      isolationLevel: "Serializable",
    }
  );
}

export async function completeGuestJourneyAccessEvaluationIntent(
  db: GuestJourneyOwnerRuntimeDb,
  input: {
    claim: ClaimedAccessEvaluationIntent;
    completion: AccessEvaluationCompletion;
    maxClaims: number;
    retryBaseMs: number;
    now?: Date;
  }
): Promise<CompleteAccessEvaluationResult> {
  const now = requireValidDate(
    input.now ?? new Date(),
    "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_NOW_INVALID"
  );
  const maxClaims =
    requirePositiveInteger(
      input.maxClaims,
      "GUEST_JOURNEY_OWNER_RUNTIME_MAX_CLAIMS_INVALID"
    );
  const retryBaseMs =
    requirePositiveInteger(
      input.retryBaseMs,
      "GUEST_JOURNEY_OWNER_RUNTIME_RETRY_BASE_MS_INVALID"
    );
  const leaseToken = requireText(
    input.claim.leaseToken,
    "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_LEASE_TOKEN_REQUIRED"
  );

  return db.$transaction(
    async (tx) => {
      const intent =
        await tx
          .guestJourneyCoordinationIntent
          .findUnique({
            where: {
              id: input.claim.intentId,
            },
            select: {
              id: true,
              intentKey: true,
              reservationId: true,
              intentType: true,
              targetEngine: true,
              expectedOutcomeCode: true,
              evidenceFingerprint: true,
              status: true,
              claimCount: true,
              leaseToken: true,
              claimedAt: true,
              leaseExpiresAt: true,
              reservation: {
                select: {
                  propertyId: true,
                  property: {
                    select: {
                      organizationId: true,
                    },
                  },
                },
              },
            },
          });

      if (!intent) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_INTENT_NOT_FOUND"
        );
      }

      assertCanonicalAccessEvaluation({
        ...intent,
        journeyId:
          input.claim.journeyId,
        nextActionAt: null,
      });

      if (
        intent.reservationId !==
          input.claim.reservationId ||
        intent.reservation.propertyId !==
          input.claim.propertyId ||
        intent.reservation.property
            .organizationId !==
          input.claim.organizationId
      ) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_SCOPE_MISMATCH"
        );
      }

      if (
        intent.status !==
        GuestJourneyCoordinationIntentStatus
          .CLAIMED
      ) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_CLAIM_REQUIRED"
        );
      }

      if (
        intent.claimCount !==
          input.claim.attemptNumber ||
        intent.leaseToken !==
          leaseToken ||
        !intent.claimedAt ||
        !intent.leaseExpiresAt
      ) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_LEASE_MISMATCH"
        );
      }

      if (
        intent.leaseExpiresAt.getTime() <=
        now.getTime()
      ) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_LEASE_EXPIRED"
        );
      }

      const attempt =
        await tx
          .guestJourneyCoordinationIntentAttempt
          .findUnique({
            where: {
              intentId_attemptNumber: {
                intentId: intent.id,
                attemptNumber:
                  intent.claimCount,
              },
            },
            select: {
              id: true,
              outcome: true,
              startedAt: true,
              leaseExpiresAt: true,
              leaseTokenFingerprint: true,
              inputEvidenceFingerprint: true,
            },
          });

      if (
        !attempt ||
        attempt.outcome !==
          GuestJourneyCoordinationAttemptOutcome
            .IN_FLIGHT ||
        attempt.leaseExpiresAt.getTime() !==
          intent.leaseExpiresAt.getTime() ||
        attempt.leaseTokenFingerprint !==
          fingerprintLeaseToken(
            leaseToken
          )
      ) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_ATTEMPT_EVIDENCE_MISMATCH"
        );
      }

      const exhausted =
        input.completion.kind ===
          "RETRYABLE" &&
        intent.claimCount >= maxClaims;
      const status = exhausted
        ? GuestJourneyCoordinationIntentStatus
            .EXHAUSTED
        : GuestJourneyCoordinationIntentStatus[
            input.completion.kind
          ];
      const outcome = exhausted
        ? GuestJourneyCoordinationAttemptOutcome
            .EXHAUSTED
        : GuestJourneyCoordinationAttemptOutcome[
            input.completion.kind
          ];
      const nextActionAt =
        status ===
        GuestJourneyCoordinationIntentStatus
          .RETRYABLE
          ? calculateRetryAt({
              attemptNumber:
                intent.claimCount,
              retryBaseMs,
              now,
            })
          : null;
      const outcomeEvidenceFingerprint =
        "outcomeEvidenceFingerprint" in
        input.completion
          ? requireText(
              input.completion
                .outcomeEvidenceFingerprint,
              "GUEST_JOURNEY_OWNER_RUNTIME_OUTCOME_EVIDENCE_REQUIRED"
            )
          : intent.evidenceFingerprint;
      const errorCode =
        "errorCode" in input.completion
          ? requireText(
              input.completion.errorCode,
              "GUEST_JOURNEY_OWNER_RUNTIME_ERROR_CODE_REQUIRED"
            )
          : null;
      const errorDetail =
        "errorDetail" in input.completion
          ? truncateErrorDetail(
              input.completion.errorDetail
            )
          : null;

      const completedIntent =
        await tx
          .guestJourneyCoordinationIntent
          .updateMany({
            where: {
              id: intent.id,
              status:
                GuestJourneyCoordinationIntentStatus
                  .CLAIMED,
              claimCount:
                intent.claimCount,
              leaseToken,
              claimedAt:
                intent.claimedAt,
              leaseExpiresAt:
                intent.leaseExpiresAt,
            },
            data: {
              status,
              leaseToken: null,
              claimedAt: null,
              leaseExpiresAt: null,
              nextActionAt,
              succeededAt:
                status ===
                GuestJourneyCoordinationIntentStatus
                  .SUCCEEDED
                  ? now
                  : null,
              exhaustedAt:
                status ===
                GuestJourneyCoordinationIntentStatus
                  .EXHAUSTED
                  ? now
                  : null,
              outcomeEvidenceFingerprint,
              lastError:
                errorCode && errorDetail
                  ? `${errorCode}:${errorDetail}`
                  : errorCode,
            },
          });

      if (completedIntent.count !== 1) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_RACE"
        );
      }

      const completedAttempt =
        await tx
          .guestJourneyCoordinationIntentAttempt
          .updateMany({
            where: {
              id: attempt.id,
              intentId: intent.id,
              attemptNumber:
                intent.claimCount,
              outcome:
                GuestJourneyCoordinationAttemptOutcome
                  .IN_FLIGHT,
            },
            data: {
              outcome,
              completedAt: now,
              outcomeEvidenceFingerprint,
              errorCode:
                exhausted
                  ? "OWNER_RUNTIME_CLAIM_BUDGET_EXHAUSTED"
                  : errorCode,
              errorDetail,
            },
          });

      if (completedAttempt.count !== 1) {
        throw new Error(
          "GUEST_JOURNEY_OWNER_RUNTIME_COMPLETION_ATTEMPT_RACE"
        );
      }

      const action = exhausted
        ? "EXHAUSTED"
        : input.completion.kind;

      await persistAuditEntry(
        tx,
        buildRuntimeAudit({
          action,
          intentId: intent.id,
          intentKey: intent.intentKey,
          reservationId:
            intent.reservationId,
          organizationId:
            intent.reservation.property
              .organizationId,
          propertyId:
            intent.reservation
              .propertyId,
          attemptNumber:
            intent.claimCount,
          startedAt:
            attempt.startedAt,
          completedAt: now,
          inputEvidenceFingerprint:
            attempt.inputEvidenceFingerprint,
          outcomeEvidenceFingerprint,
          leaseTokenFingerprint:
            attempt.leaseTokenFingerprint,
          errorCode:
            exhausted
              ? "OWNER_RUNTIME_CLAIM_BUDGET_EXHAUSTED"
              : errorCode,
        })
      );

      return {
        intentId: intent.id,
        attemptNumber:
          intent.claimCount,
        status,
        nextActionAt,
      };
    },
    {
      isolationLevel: "Serializable",
    }
  );
}

export function normalizeOwnerRuntimeError(
  error: unknown
): {
  code: string;
  detail: string;
} {
  const structuredCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown })
      .code === "string"
      ? (error as { code: string })
          .code
      : null;
  const detail =
    error instanceof Error
      ? error.stack || error.message
      : String(error);
  const source =
    structuredCode ??
    (error instanceof Error
      ? error.message
      : String(error));
  const code = source
    .split(":", 1)[0]
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase();

  return {
    code: code || "UNKNOWN_ERROR",
    detail:
      truncateErrorDetail(detail),
  };
}
