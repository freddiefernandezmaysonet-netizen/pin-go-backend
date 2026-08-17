import {
  GuestJourneyCoordinationIntentStatus,
  GuestJourneyState,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import type {
  AuditEntry,
} from "../apms/audit-types";

import {
  persistAuditEntry,
} from "../apms/audit-persistence.service";

import {
  CANONICAL_GUEST_JOURNEY_STATE_ORDER,
} from "./guest-journey-contract";

import type {
  CanonicalJourneyEvaluation,
  GuestJourneyCoordinationIntentSnapshot,
  GuestJourneyEvidenceSnapshot,
  ProposedJourneyCoordinationIntent,
} from "./guest-journey-contract";

import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";

import {
  loadGuestJourneyEvidence,
} from "./guest-journey-evidence.service";

import {
  ensureGuestJourneyCoordinationIntent,
  markGuestJourneyCoordinationIntentSucceeded,
  supersedeObsoleteGuestJourneyCoordinationIntents,
} from "./guest-journey-coordination-intent.service";

/**
 * Guest Journey Reconciler Core V1.
 *
 * Responsibility:
 * Evidence Loader -> Canonical Evaluator -> reconcile Guest Journey-owned
 * persistence -> coordinate owner Engines through durable intents.
 *
 * This service does NOT:
 * - execute Access;
 * - perform identity verification;
 * - send messages;
 * - evaluate payment providers;
 * - mutate Mission Control.
 */

const GUEST_JOURNEY_LOCK_PREFIX =
  "GUEST_JOURNEY:";

export type GuestJourneyReconcileActionCode =
  | "NO_ACTION"
  | "CREATE_JOURNEY_FROM_EVIDENCE"
  | "ADVANCE_CANONICAL_TRANSITIONS"
  | "APPLY_INTERNAL_REPAIR"
  | "ENSURE_COORDINATION_INTENT"
  | "WAIT_FOR_OUTCOME_EVIDENCE"
  | "VERIFY_INTENT_SUCCEEDED"
  | "SUPERSEDE_INTENT";

export type GuestJourneyReconcileAction = {
  code:
    GuestJourneyReconcileActionCode;

  detail: string;

  metadata?:
    Record<string, unknown>;
};

export type GuestJourneyReconcileResult = {
  reservationId: string;
  journeyId: string | null;

  evaluation:
    CanonicalJourneyEvaluation;

  initialPersistedState:
    GuestJourneyState | null;

  finalPersistedState:
    GuestJourneyState | null;

  actions:
    GuestJourneyReconcileAction[];
};

export type GuestJourneyReconcilerTransactionClient =
  Pick<
    Prisma.TransactionClient,
    | "$executeRawUnsafe"
    | "reservation"
    | "messageLog"
    | "guestJourney"
    | "guestJourneyCoordinationIntent"
    | "apmsAuditEntry"
  >;

type JourneyIdentity = {
  id: string;
  currentState: GuestJourneyState;
};

function requireReservationId(
  value: string
): string {
  const cleanValue =
    value.trim();

  if (!cleanValue) {
    throw new Error(
      "reservationId is required"
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

function maxDate(
  first: Date,
  second: Date
): Date {
  return first.getTime() >=
    second.getTime()
    ? first
    : second;
}

function verificationEffectiveAt(
  evidence:
    GuestJourneyEvidenceSnapshot
): Date {
  if (
    evidence.verification.status ===
      "COMPLETED" &&
    evidence.verification.verifiedAt
  ) {
    return evidence.verification
      .verifiedAt;
  }

  if (
    evidence.verification.status ===
      "NOT_REQUIRED" &&
    evidence.requirements
      .agreementSignedAt
  ) {
    return evidence.requirements
      .agreementSignedAt;
  }

  throw new Error(
    "GUEST_JOURNEY_RECONCILER_VERIFICATION_TIMESTAMP_MISSING"
  );
}

function stateEffectiveAt(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state:
    GuestJourneyState,
  now: Date
): Date | null {
  switch (state) {
    case GuestJourneyState
      .RESERVATION_CONFIRMED:

    case GuestJourneyState
      .VERIFICATION_PENDING:
      return null;

    case GuestJourneyState
      .VERIFICATION_COMPLETED:
      return verificationEffectiveAt(
        evidence
      );

    case GuestJourneyState
      .ACCESS_SCHEDULED:
      if (
        !evidence.access.releasedAt
      ) {
        throw new Error(
          "GUEST_JOURNEY_RECONCILER_ACCESS_RELEASE_TIMESTAMP_MISSING"
        );
      }

      return evidence.access
        .releasedAt;

    case GuestJourneyState
      .READY_FOR_ARRIVAL: {
      if (
        !evidence.access.releasedAt
      ) {
        throw new Error(
          "GUEST_JOURNEY_RECONCILER_ACCESS_RELEASE_TIMESTAMP_MISSING"
        );
      }

      const arrivalWindowAt =
        new Date(
          evidence.reservation
            .checkIn.getTime() -
            2 * 60 * 60 * 1000
        );

      return maxDate(
        arrivalWindowAt,
        evidence.access.releasedAt
      );
    }

    case GuestJourneyState
      .STAY_ACTIVE:
      if (
        !evidence.access.releasedAt
      ) {
        throw new Error(
          "GUEST_JOURNEY_RECONCILER_ACCESS_RELEASE_TIMESTAMP_MISSING"
        );
      }

      return maxDate(
        evidence.reservation.checkIn,
        evidence.access.releasedAt
      );

    case GuestJourneyState
      .CHECKOUT_DUE:
      return evidence.reservation
        .checkOut;

    case GuestJourneyState
      .JOURNEY_COMPLETED:
      return now;

    case GuestJourneyState
      .JOURNEY_CANCELLED:
      return (
        evidence.reservation
          .cancelledAt ??
        now
      );
  }
}

function buildStateCreateData(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state:
    GuestJourneyState,
  now: Date
): Prisma.GuestJourneyCreateManyInput {
  const stateAt =
    stateEffectiveAt(
      evidence,
      state,
      now
    );

  const base:
    Prisma.GuestJourneyCreateManyInput =
    {
      reservationId:
        evidence.reservation.id,

      currentState:
        state,

      stateChangedAt:
        now,
    };

  switch (state) {
    case GuestJourneyState
      .VERIFICATION_COMPLETED:
      return {
        ...base,
        verificationCompletedAt:
          stateAt!,
      };

    case GuestJourneyState
      .ACCESS_SCHEDULED:
      return {
        ...base,
        accessScheduledAt:
          stateAt!,
      };

    case GuestJourneyState
      .READY_FOR_ARRIVAL:
      return {
        ...base,
        readyForArrivalAt:
          stateAt!,
      };

    case GuestJourneyState
      .STAY_ACTIVE:
      return {
        ...base,
        stayActiveAt:
          stateAt!,
      };

    case GuestJourneyState
      .CHECKOUT_DUE:
      return {
        ...base,
        checkoutDueAt:
          stateAt!,
      };

    case GuestJourneyState
      .JOURNEY_COMPLETED:
      return {
        ...base,
        completedAt:
          stateAt!,
      };

    case GuestJourneyState
      .JOURNEY_CANCELLED:
      return {
        ...base,
        cancelledAt:
          stateAt!,
      };

    case GuestJourneyState
      .RESERVATION_CONFIRMED:

    case GuestJourneyState
      .VERIFICATION_PENDING:
      return base;
  }
}

function buildStateTransitionData(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state:
    GuestJourneyState,
  now: Date
): Prisma.GuestJourneyUpdateManyMutationInput {
  const stateAt =
    stateEffectiveAt(
      evidence,
      state,
      now
    );

  const base:
    Prisma.GuestJourneyUpdateManyMutationInput =
    {
      currentState:
        state,

      stateChangedAt:
        now,
    };

  switch (state) {
    case GuestJourneyState
      .VERIFICATION_COMPLETED:
      return {
        ...base,
        verificationCompletedAt:
          stateAt!,
      };

    case GuestJourneyState
      .ACCESS_SCHEDULED:
      return {
        ...base,
        accessScheduledAt:
          stateAt!,
      };

    case GuestJourneyState
      .READY_FOR_ARRIVAL:
      return {
        ...base,
        readyForArrivalAt:
          stateAt!,
      };

    case GuestJourneyState
      .STAY_ACTIVE:
      return {
        ...base,
        stayActiveAt:
          stateAt!,
      };

    case GuestJourneyState
      .CHECKOUT_DUE:
      return {
        ...base,
        checkoutDueAt:
          stateAt!,
      };

    case GuestJourneyState
      .JOURNEY_COMPLETED:
      return {
        ...base,
        completedAt:
          stateAt!,
      };

    case GuestJourneyState
      .JOURNEY_CANCELLED:
      return {
        ...base,
        cancelledAt:
          stateAt!,
      };

    case GuestJourneyState
      .RESERVATION_CONFIRMED:

    case GuestJourneyState
      .VERIFICATION_PENDING:
      return base;
  }
}

async function persistReconcilerAudit(
  tx:
    GuestJourneyReconcilerTransactionClient,
  input: {
    decisionId: string;
    summary: string;
    reason: string;
    rule: string;
    label: string;
    previousValue?: unknown;
    newValue?: unknown;

    evidence:
      GuestJourneyEvidenceSnapshot;

    evaluation:
      CanonicalJourneyEvaluation;

    now: Date;

    metadata?:
      Record<string, unknown>;
  }
) {
  const auditEntry:
    AuditEntry = {
    engine:
      "Guest Journey",

    decisionId:
      input.decisionId,

    entityType:
      "RESERVATION",

    entityId:
      input.evidence
        .reservation.id,

    eventType:
      "DECISION_APPLIED",

    status:
      "SUCCESS",

    severity:
      "INFO",

    summary:
      input.summary,

    reason:
      input.reason,

    startedAt:
      input.now,

    completedAt:
      input.now,

    durationMs:
      0,

    decisions: [
      {
        engine:
          "Guest Journey",

        rule:
          input.rule,

        label:
          input.label,

        previousValue:
          input.previousValue,

        newValue:
          input.newValue,

        applied:
          true,

        metadata: {
          evidenceFingerprint:
            input.evaluation
              .evidenceFingerprint,

          expectedState:
            input.evaluation
              .expectedState,

          comparison:
            input.evaluation
              .comparison,

          ...input.metadata,
        },
      },
    ],

    metadata: {
      organizationId:
        input.evidence
          .reservation
          .organizationId,

      propertyId:
        input.evidence
          .reservation.propertyId,

      reservationId:
        input.evidence
          .reservation.id,

      evidenceFingerprint:
        input.evaluation
          .evidenceFingerprint,

      expectedState:
        input.evaluation
          .expectedState,

      comparison:
        input.evaluation
          .comparison,

      ...input.metadata,
    },
  };

  await persistAuditEntry(
    tx,
    auditEntry
  );
}

async function readJourney(
  tx:
    GuestJourneyReconcilerTransactionClient,
  reservationId: string
): Promise<
  JourneyIdentity | null
> {
  return tx.guestJourney
    .findUnique({
      where: {
        reservationId,
      },

      select: {
        id: true,
        currentState: true,
      },
    });
}

async function reconstructMissingJourney(
  tx:
    GuestJourneyReconcilerTransactionClient,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date
): Promise<{
  journey:
    JourneyIdentity;

  created:
    boolean;
}> {
  const createResult =
    await tx.guestJourney
      .createMany({
        data: [
          buildStateCreateData(
            evidence,
            evaluation.expectedState,
            now
          ),
        ],

        skipDuplicates:
          true,
      });

  const journey =
    await readJourney(
      tx,
      evidence.reservation.id
    );

  if (!journey) {
    throw new Error(
      "GUEST_JOURNEY_RECONCILER_CREATE_MISSING_JOURNEY_FAILED"
    );
  }

  if (
    createResult.count === 1
  ) {
    await persistReconcilerAudit(
      tx,
      {
        decisionId:
          `guest-journey-reconciler:${evidence.reservation.id}:reconstructed:${evaluation.expectedState}`,

        summary:
          "Guest Journey reconstructed from canonical persisted evidence.",

        reason:
          "No Guest Journey existed, so the reconciler created it directly at the highest state proven by persisted evidence without synthesizing historical transitions.",

        rule:
          "RECONSTRUCT_FROM_EVIDENCE",

        label:
          "Reconstruct Guest Journey",

        previousValue:
          null,

        newValue:
          evaluation.expectedState,

        evidence,
        evaluation,
        now,

        metadata: {
          journeyId:
            journey.id,

          reconstructedState:
            evaluation.expectedState,

          stateEffectiveAt:
            stateEffectiveAt(
              evidence,
              evaluation.expectedState,
              now
            ),
        },
      }
    );
  }

  return {
    journey,
    created:
      createResult.count === 1,
  };
}

function canonicalTransitionTargets(
  currentState:
    GuestJourneyState,
  expectedState:
    GuestJourneyState
): GuestJourneyState[] {
  if (
    expectedState ===
    GuestJourneyState
      .JOURNEY_CANCELLED
  ) {
    return [
      GuestJourneyState
        .JOURNEY_CANCELLED,
    ];
  }

  const currentIndex =
    CANONICAL_GUEST_JOURNEY_STATE_ORDER
      .findIndex(
        (state) =>
          state === currentState
      );

  const expectedIndex =
    CANONICAL_GUEST_JOURNEY_STATE_ORDER
      .findIndex(
        (state) =>
          state === expectedState
      );

  if (
    currentIndex < 0 ||
    expectedIndex < 0 ||
    currentIndex >= expectedIndex
  ) {
    return [];
  }

  return [
    ...CANONICAL_GUEST_JOURNEY_STATE_ORDER
      .slice(
        currentIndex + 1,
        expectedIndex + 1
      ),
  ];
}

async function advanceCanonicalTransitions(
  tx:
    GuestJourneyReconcilerTransactionClient,
  journey:
    JourneyIdentity,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date
): Promise<{
  finalState:
    GuestJourneyState;

  transitionCount:
    number;

  compareAndSetLost:
    boolean;
}> {
  const targets =
    canonicalTransitionTargets(
      journey.currentState,
      evaluation.expectedState
    );

  let currentState =
    journey.currentState;

  let transitionCount =
    0;

  for (
    const targetState of
    targets
  ) {
    const transitionResult =
      await tx.guestJourney
        .updateMany({
          where: {
            id:
              journey.id,

            currentState,
          },

          data:
            buildStateTransitionData(
              evidence,
              targetState,
              now
            ),
        });

    if (
      transitionResult.count === 0
    ) {
      const winner =
        await tx.guestJourney
          .findUniqueOrThrow({
            where: {
              id:
                journey.id,
            },

            select: {
              currentState:
                true,
            },
          });

      return {
        finalState:
          winner.currentState,

        transitionCount,

        compareAndSetLost:
          true,
      };
    }

    await persistReconcilerAudit(
      tx,
      {
        decisionId:
          `guest-journey-reconciler:${journey.id}:${currentState}-to-${targetState}`,

        summary:
          `Guest Journey advanced from ${currentState} to ${targetState}.`,

        reason:
          "The Canonical Journey Evaluator determined that persisted evidence proves the next lifecycle state.",

        rule:
          "ADVANCE_CANONICAL_GUEST_JOURNEY",

        label:
          "Advance Guest Journey",

        previousValue:
          currentState,

        newValue:
          targetState,

        evidence,
        evaluation,
        now,

        metadata: {
          journeyId:
            journey.id,

          fromState:
            currentState,

          toState:
            targetState,

          stateEffectiveAt:
            stateEffectiveAt(
              evidence,
              targetState,
              now
            ),
        },
      }
    );

    currentState =
      targetState;

    transitionCount += 1;
  }

  return {
    finalState:
      currentState,

    transitionCount,

    compareAndSetLost:
      false,
  };
}

async function repairCurrentStateTimestamp(
  tx:
    GuestJourneyReconcilerTransactionClient,
  journey:
    JourneyIdentity,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date
): Promise<boolean> {
  const stateAt =
    stateEffectiveAt(
      evidence,
      journey.currentState,
      now
    );

  if (!stateAt) {
    return false;
  }

  let count =
    0;

  switch (
    journey.currentState
  ) {
    case GuestJourneyState
      .VERIFICATION_COMPLETED:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              verificationCompletedAt:
                null,
            },

            data: {
              verificationCompletedAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .ACCESS_SCHEDULED:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              accessScheduledAt:
                null,
            },

            data: {
              accessScheduledAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .READY_FOR_ARRIVAL:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              readyForArrivalAt:
                null,
            },

            data: {
              readyForArrivalAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .STAY_ACTIVE:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              stayActiveAt:
                null,
            },

            data: {
              stayActiveAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .CHECKOUT_DUE:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              checkoutDueAt:
                null,
            },

            data: {
              checkoutDueAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .JOURNEY_COMPLETED:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              completedAt:
                null,
            },

            data: {
              completedAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .JOURNEY_CANCELLED:
      count = (
        await tx.guestJourney
          .updateMany({
            where: {
              id:
                journey.id,

              currentState:
                journey.currentState,

              cancelledAt:
                null,
            },

            data: {
              cancelledAt:
                stateAt,
            },
          })
      ).count;
      break;

    case GuestJourneyState
      .RESERVATION_CONFIRMED:

    case GuestJourneyState
      .VERIFICATION_PENDING:
      return false;
  }

  if (count !== 1) {
    return false;
  }

  await persistReconcilerAudit(
    tx,
    {
      decisionId:
        `guest-journey-reconciler:${journey.id}:repair-timestamp:${journey.currentState}`,

      summary:
        `Guest Journey repaired the missing ${journey.currentState} lifecycle timestamp.`,

      reason:
        "The canonical state was already persisted, but its state-specific lifecycle timestamp was missing and could be reconstructed from persisted evidence.",

      rule:
        "REPAIR_GUEST_JOURNEY_TIMESTAMP",

      label:
        "Repair Guest Journey Timestamp",

      previousValue:
        null,

      newValue:
        stateAt,

      evidence,
      evaluation,
      now,

      metadata: {
        journeyId:
          journey.id,

        currentState:
          journey.currentState,

        repairedTimestamp:
          stateAt,
      },
    }
  );

  return true;
}

function waitingIntentOutcomeSatisfied(
  intent:
    GuestJourneyCoordinationIntentSnapshot,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation
): boolean {
  switch (
    intent.expectedOutcomeCode
  ) {
    case "REQUIREMENTS_SNAPSHOTS_PRESENT":
      return (
        evidence.requirements
          .agreementSnapshotPresent &&
        evidence.requirements
          .cancellationSnapshotPresent
      );

    case "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED":
      return (
        evaluation.outcomeEvidence
          .legalRequirementsSatisfied &&
        evaluation.outcomeEvidence
          .identityRequirementSatisfied
      );

    case "ACCESS_RELEASE_STATUS_ELIGIBLE":
      return evaluation.outcomeEvidence
        .accessEligibilitySatisfied;

    case "SECURE_GUEST_ACCESS_ACTIVE":
      return evaluation.outcomeEvidence
        .accessProvisioningSatisfied;

    case "ALL_GUEST_ACCESS_CLOSED":
      return evaluation.outcomeEvidence
        .accessClosureSatisfied;

    case "PAYMENT_STATE_RESOLVED":
      return evaluation.outcomeEvidence
        .paymentSatisfied;

    /*
     * Communication outcome verification requires correlation with the
     * owner Engine's concrete delivery attempt. That integration belongs
     * to Capability E and is intentionally not guessed here.
     */
    case "COMMUNICATION_DELIVERY_FINAL":
      return false;

    default:
      return false;
  }
}

async function verifyWaitingIntents(
  tx:
    GuestJourneyReconcilerTransactionClient,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date
): Promise<number> {
  let succeededCount =
    0;

  for (
    const intent of
    evidence.activeIntents
  ) {
    if (
      intent.status !==
      GuestJourneyCoordinationIntentStatus
        .WAITING_FOR_EVIDENCE
    ) {
      continue;
    }

    if (
      !waitingIntentOutcomeSatisfied(
        intent,
        evidence,
        evaluation
      )
    ) {
      continue;
    }

    const result =
      await markGuestJourneyCoordinationIntentSucceeded(
        tx,
        {
          intentId:
            intent.id,

          outcomeEvidenceFingerprint:
            evaluation
              .evidenceFingerprint,

          now,
        }
      );

    if (
      !result.transitioned
    ) {
      continue;
    }

    succeededCount += 1;

    await persistReconcilerAudit(
      tx,
      {
        decisionId:
          `guest-journey-reconciler:${intent.id}:outcome-verified:${evaluation.evidenceFingerprint}`,

        summary:
          `Guest Journey verified successful outcome evidence for coordination intent ${intent.intentType}.`,

        reason:
          "The owner Engine intent was waiting for persisted outcome evidence, and the canonical evidence now proves its expected outcome.",

        rule:
          "VERIFY_COORDINATION_INTENT_OUTCOME",

        label:
          "Verify Coordination Intent",

        previousValue:
          GuestJourneyCoordinationIntentStatus
            .WAITING_FOR_EVIDENCE,

        newValue:
          GuestJourneyCoordinationIntentStatus
            .SUCCEEDED,

        evidence,
        evaluation,
        now,

        metadata: {
          intentId:
            intent.id,

          intentKey:
            intent.intentKey,

          intentType:
            intent.intentType,

          targetEngine:
            intent.targetEngine,

          expectedOutcomeCode:
            intent.expectedOutcomeCode,

          outcomeEvidenceFingerprint:
            evaluation
              .evidenceFingerprint,
        },
      }
    );
  }

  return succeededCount;
}

async function ensureRequiredIntents(
  tx:
    GuestJourneyReconcilerTransactionClient,
  journeyId: string,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date
): Promise<number> {
  let createdCount =
    0;

  for (
    const intent of
    evaluation
      .requiredCoordinationIntents
  ) {
    const result =
      await ensureGuestJourneyCoordinationIntent(
        tx,
        {
          reservationId:
            evidence.reservation.id,

          journeyId,

          evidenceFingerprint:
            evaluation
              .evidenceFingerprint,

          intent:
            intent as
              ProposedJourneyCoordinationIntent,
        }
      );

    if (!result.created) {
      continue;
    }

    createdCount += 1;

    await persistReconcilerAudit(
      tx,
      {
        decisionId:
          `guest-journey-reconciler:${journeyId}:intent:${result.intent.intentKey}`,

        summary:
          `Guest Journey created coordination intent ${result.intent.intentType} for ${result.intent.targetEngine}.`,

        reason:
          "The Canonical Journey Evaluator requires an owner Engine outcome that Guest Journey is not permitted to execute directly.",

        rule:
          "ENSURE_COORDINATION_INTENT",

        label:
          "Coordinate Owner Engine",

        previousValue:
          null,

        newValue:
          result.intent.intentType,

        evidence,
        evaluation,
        now,

        metadata: {
          journeyId,

          intentId:
            result.intent.id,

          intentKey:
            result.intent.intentKey,

          intentType:
            result.intent.intentType,

          targetEngine:
            result.intent.targetEngine,

          reasonCode:
            result.intent.reasonCode,

          expectedOutcomeCode:
            result.intent
              .expectedOutcomeCode,
        },
      }
    );
  }

  return createdCount;
}

function hasUnsatisfiedCurrentWaitingIntent(
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation
): boolean {
  return evidence.activeIntents
    .some(
      (intent) =>
        intent.status ===
          GuestJourneyCoordinationIntentStatus
            .WAITING_FOR_EVIDENCE &&
        intent.evidenceFingerprint ===
          evaluation
            .evidenceFingerprint &&
        !waitingIntentOutcomeSatisfied(
          intent,
          evidence,
          evaluation
        )
    );
}

export async function reconcileGuestJourneyInTransaction(
  tx:
    GuestJourneyReconcilerTransactionClient,
  reservationId: string,
  now: Date
): Promise<
  GuestJourneyReconcileResult
> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );

  const evaluatedAt =
    requireValidDate(
      now,
      "now"
    );

  const evidence =
    await loadGuestJourneyEvidence(
      tx,
      cleanReservationId,
      evaluatedAt
    );

  const evaluation =
    evaluateCanonicalGuestJourney(
      evidence
    );

  const actions:
    GuestJourneyReconcileAction[] = [];

  const initialPersistedState =
    evaluation.persistedState;

  let journey:
    JourneyIdentity | null =
    evidence.persistedJourney
      .exists &&
    evidence.persistedJourney.id &&
    evidence.persistedJourney
      .currentState
      ? {
          id:
            evidence.persistedJourney.id,

          currentState:
            evidence.persistedJourney
              .currentState,
        }
      : null;

  if (
    evaluation.comparison ===
    "MISSING"
  ) {
    const reconstructed =
      await reconstructMissingJourney(
        tx,
        evidence,
        evaluation,
        evaluatedAt
      );

    journey =
      reconstructed.journey;

    if (
      reconstructed.created
    ) {
      actions.push({
        code:
          "CREATE_JOURNEY_FROM_EVIDENCE",

        detail:
          `Created Guest Journey directly at ${journey.currentState}.`,

        metadata: {
          journeyId:
            journey.id,

          expectedState:
            evaluation.expectedState,
        },
      });
    }
  }

  if (
    journey &&
    evaluation.comparison !==
      "AHEAD_OF_EVIDENCE" &&
    evaluation.comparison !==
      "TERMINAL_CONTRADICTION" &&
    evaluation
      .requiredInternalRepairs
      .some(
        (repair) =>
          repair.code ===
          "REPAIR_GUEST_JOURNEY_TIMESTAMP"
      )
  ) {
    const repaired =
      await repairCurrentStateTimestamp(
        tx,
        journey,
        evidence,
        evaluation,
        evaluatedAt
      );

    if (repaired) {
      actions.push({
        code:
          "APPLY_INTERNAL_REPAIR",

        detail:
          `Repaired canonical timestamp for ${journey.currentState}.`,

        metadata: {
          journeyId:
            journey.id,

          currentState:
            journey.currentState,
        },
      });
    }
  }

  if (
    journey &&
    evaluation.comparison ===
      "BEHIND"
  ) {
    const advanceResult =
      await advanceCanonicalTransitions(
        tx,
        journey,
        evidence,
        evaluation,
        evaluatedAt
      );

    journey = {
      id:
        journey.id,

      currentState:
        advanceResult.finalState,
    };

    if (
      advanceResult
        .transitionCount > 0
    ) {
      actions.push({
        code:
          "ADVANCE_CANONICAL_TRANSITIONS",

        detail:
          `Applied ${advanceResult.transitionCount} canonical Guest Journey transition(s).`,

        metadata: {
          journeyId:
            journey.id,

          transitionCount:
            advanceResult
              .transitionCount,

          finalState:
            advanceResult
              .finalState,

          compareAndSetLost:
            advanceResult
              .compareAndSetLost,
        },
      });
    }
  }

  if (journey) {
    const verifiedIntentCount =
      await verifyWaitingIntents(
        tx,
        evidence,
        evaluation,
        evaluatedAt
      );

    if (
      verifiedIntentCount > 0
    ) {
      actions.push({
        code:
          "VERIFY_INTENT_SUCCEEDED",

        detail:
          `Verified persisted outcome evidence for ${verifiedIntentCount} coordination intent(s).`,

        metadata: {
          verifiedIntentCount,
        },
      });
    }

    /*
     * Ordering is deliberate:
     * 1. verify WAITING intents against the new evidence;
     * 2. supersede only the remaining active intents from obsolete evidence;
     * 3. create any newly-required intent for the current fingerprint.
     */
    const supersededCount =
      await supersedeObsoleteGuestJourneyCoordinationIntents(
        tx,
        {
          reservationId:
            evidence.reservation.id,

          activeEvidenceFingerprint:
            evaluation
              .evidenceFingerprint,

          now:
            evaluatedAt,
        }
      );

    if (
      supersededCount > 0
    ) {
      actions.push({
        code:
          "SUPERSEDE_INTENT",

        detail:
          `Superseded ${supersededCount} coordination intent(s) created from obsolete evidence.`,

        metadata: {
          supersededCount,

          activeEvidenceFingerprint:
            evaluation
              .evidenceFingerprint,
        },
      });

      await persistReconcilerAudit(
        tx,
        {
          decisionId:
            `guest-journey-reconciler:${journey.id}:supersede:${evaluation.evidenceFingerprint}`,

          summary:
            "Guest Journey superseded coordination intents created from obsolete evidence.",

          reason:
            "The canonical evidence fingerprint changed, so active intents based on older evidence must not continue executing.",

          rule:
            "SUPERSEDE_OBSOLETE_COORDINATION_INTENTS",

          label:
            "Supersede Obsolete Intents",

          previousValue:
            "ACTIVE_OBSOLETE_INTENTS",

          newValue:
            "SUPERSEDED",

          evidence,
          evaluation,
          now:
            evaluatedAt,

          metadata: {
            journeyId:
              journey.id,

            supersededCount,

            activeEvidenceFingerprint:
              evaluation
                .evidenceFingerprint,
          },
        }
      );
    }

    const createdIntentCount =
      await ensureRequiredIntents(
        tx,
        journey.id,
        evidence,
        evaluation,
        evaluatedAt
      );

    if (
      createdIntentCount > 0
    ) {
      actions.push({
        code:
          "ENSURE_COORDINATION_INTENT",

        detail:
          `Created ${createdIntentCount} required coordination intent(s).`,

        metadata: {
          createdIntentCount,
        },
      });
    }
  }

  if (
    hasUnsatisfiedCurrentWaitingIntent(
      evidence,
      evaluation
    )
  ) {
    actions.push({
      code:
        "WAIT_FOR_OUTCOME_EVIDENCE",

      detail:
        "One or more current coordination intents are waiting for persisted owner Engine outcome evidence.",
    });
  }

  if (
    actions.length === 0
  ) {
    actions.push({
      code:
        "NO_ACTION",

      detail:
        evaluation.comparison ===
          "AHEAD_OF_EVIDENCE"
          ? "Persisted Guest Journey is ahead of canonical evidence. The reconciler did not regress state."
          : evaluation.comparison ===
              "TERMINAL_CONTRADICTION"
            ? "Persisted terminal Guest Journey contradicts current evidence. The reconciler preserved the immutable terminal state."
            : "Guest Journey is aligned with canonical persisted evidence and requires no material reconciliation.",
    });
  }

  return {
    reservationId:
      evidence.reservation.id,

    journeyId:
      journey?.id ?? null,

    evaluation,

    initialPersistedState,

    finalPersistedState:
      journey?.currentState ??
      initialPersistedState,

    actions,
  };
}

export async function reconcileGuestJourney(
  prisma: PrismaClient,
  reservationId: string,
  options?: {
    now?: Date;
  }
): Promise<
  GuestJourneyReconcileResult
> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );

  const now =
    requireValidDate(
      options?.now ??
        new Date(),
      "now"
    );

  const advisoryLockKey =
    `${GUEST_JOURNEY_LOCK_PREFIX}${cleanReservationId}`;

  return prisma.$transaction(
    async (tx) => {
      await tx
        .$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          advisoryLockKey
        );

      return reconcileGuestJourneyInTransaction(
        tx,
        cleanReservationId,
        now
      );
    }
  );
}