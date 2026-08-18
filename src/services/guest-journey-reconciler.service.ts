import {
  GuestJourneyState,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import type { AuditEntry } from "../apms/audit-types";
import {
  persistAuditEntry,
} from "../apms/audit-persistence.service";
import {
  CANONICAL_GUEST_JOURNEY_STATE_ORDER,
} from "./guest-journey-contract";
import type {
  CanonicalJourneyEvaluation,
  GuestJourneyEvidenceSnapshot,
} from "./guest-journey-contract";
import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";
import {
  loadGuestJourneyEvidence,
} from "./guest-journey-evidence.service";
import type {
  GuestJourneyEvidenceScope,
} from "./guest-journey-evidence.service";

const GUEST_JOURNEY_LOCK_PREFIX =
  "GUEST_JOURNEY:";

export type GuestJourneyInternalReconcileActionCode =
  | "NO_ACTION"
  | "CREATE_JOURNEY_FROM_EVIDENCE"
  | "ADVANCE_CANONICAL_TRANSITION"
  | "REPAIR_CANONICAL_TIMESTAMP"
  | "COMPARE_AND_SET_LOST"
  | "PRESERVE_AHEAD_STATE"
  | "PRESERVE_TERMINAL_STATE";

export type GuestJourneyInternalReconcileAction = {
  code:
    GuestJourneyInternalReconcileActionCode;
  detail: string;
  metadata?: Record<string, unknown>;
};

export type GuestJourneyInternalReconcileResult = {
  reservationId: string;
  journeyId: string | null;
  evaluation: CanonicalJourneyEvaluation;
  initialPersistedState:
    GuestJourneyState | null;
  finalPersistedState:
    GuestJourneyState | null;
  actions:
    GuestJourneyInternalReconcileAction[];
  proposedCoordinationIntentCount: number;
  coordinationIntentWrites: 0;
  operationalIssueWrites: 0;
};

export type GuestJourneyReconcilerTransactionClient =
  Pick<
    Prisma.TransactionClient,
    | "$executeRaw"
    | "reservation"
    | "guestJourney"
    | "apmsAuditEntry"
  >;

type JourneyRecord = {
  id: string;
  currentState: GuestJourneyState;
};

type GuestJourneyReconcilerDependencies = {
  loadEvidence:
    typeof loadGuestJourneyEvidence;
  evaluate:
    typeof evaluateCanonicalGuestJourney;
  persistAudit:
    typeof persistAuditEntry;
};

const DEFAULT_DEPENDENCIES:
  GuestJourneyReconcilerDependencies = {
    loadEvidence:
      loadGuestJourneyEvidence,
    evaluate:
      evaluateCanonicalGuestJourney,
    persistAudit:
      persistAuditEntry,
  };

function requireReservationId(
  value: string
): string {
  const cleanValue = value.trim();

  if (!cleanValue) {
    throw new Error(
      "GUEST_JOURNEY_RECONCILER_RESERVATION_ID_REQUIRED"
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
      `GUEST_JOURNEY_RECONCILER_${fieldName.toUpperCase()}_INVALID`
    );
  }

  return value;
}

function requireScope(
  scope: GuestJourneyEvidenceScope
): GuestJourneyEvidenceScope {
  const organizationId =
    String(scope.organizationId ?? "").trim();
  const propertyId =
    String(scope.propertyId ?? "").trim();

  if (!organizationId || !propertyId) {
    throw new Error(
      "GUEST_JOURNEY_RECONCILER_SCOPE_REQUIRED"
    );
  }

  return {
    organizationId,
    propertyId,
  };
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

function accessReleasedAt(
  evidence:
    GuestJourneyEvidenceSnapshot
): Date {
  if (!evidence.access.releasedAt) {
    throw new Error(
      "GUEST_JOURNEY_RECONCILER_ACCESS_RELEASE_TIMESTAMP_MISSING"
    );
  }

  return evidence.access.releasedAt;
}

function stateEffectiveAt(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state: GuestJourneyState,
  now: Date
): Date | null {
  switch (state) {
    case GuestJourneyState.RESERVATION_CONFIRMED:
    case GuestJourneyState.VERIFICATION_PENDING:
      return null;

    case GuestJourneyState.VERIFICATION_COMPLETED:
      return verificationEffectiveAt(
        evidence
      );

    case GuestJourneyState.ACCESS_SCHEDULED:
      return accessReleasedAt(evidence);

    case GuestJourneyState.READY_FOR_ARRIVAL:
      return maxDate(
        new Date(
          evidence.reservation.checkIn.getTime() -
            2 * 60 * 60 * 1000
        ),
        accessReleasedAt(evidence)
      );

    case GuestJourneyState.STAY_ACTIVE:
      return maxDate(
        evidence.reservation.checkIn,
        accessReleasedAt(evidence)
      );

    case GuestJourneyState.CHECKOUT_DUE:
      return evidence.reservation.checkOut;

    case GuestJourneyState.JOURNEY_COMPLETED:
      return now;

    case GuestJourneyState.JOURNEY_CANCELLED:
      return (
        evidence.reservation.cancelledAt ??
        now
      );
  }
}

type GuestJourneyTimestampData = {
  verificationCompletedAt?: Date | null;
  accessScheduledAt?: Date | null;
  readyForArrivalAt?: Date | null;
  stayActiveAt?: Date | null;
  checkoutDueAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
};

function timestampMutationForState(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state: GuestJourneyState,
  now: Date
): GuestJourneyTimestampData {
  const stateAt = stateEffectiveAt(
    evidence,
    state,
    now
  );

  switch (state) {
    case GuestJourneyState.RESERVATION_CONFIRMED:
    case GuestJourneyState.VERIFICATION_PENDING:
      return {};

    case GuestJourneyState.VERIFICATION_COMPLETED:
      return {
        verificationCompletedAt: stateAt,
      };

    case GuestJourneyState.ACCESS_SCHEDULED:
      return {
        accessScheduledAt: stateAt,
      };

    case GuestJourneyState.READY_FOR_ARRIVAL:
      return {
        readyForArrivalAt: stateAt,
      };

    case GuestJourneyState.STAY_ACTIVE:
      return {
        stayActiveAt: stateAt,
      };

    case GuestJourneyState.CHECKOUT_DUE:
      return {
        checkoutDueAt: stateAt,
      };

    case GuestJourneyState.JOURNEY_COMPLETED:
      return {
        completedAt: stateAt,
      };

    case GuestJourneyState.JOURNEY_CANCELLED:
      return {
        cancelledAt: stateAt,
      };
  }
}

function buildReconstructionData(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state: GuestJourneyState,
  now: Date
): Prisma.GuestJourneyCreateManyInput {
  return {
    reservationId:
      evidence.reservation.id,
    currentState: state,
    stateChangedAt: now,
    ...timestampMutationForState(
      evidence,
      state,
      now
    ),
  };
}

function buildTransitionData(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state: GuestJourneyState,
  now: Date
): Prisma.GuestJourneyUpdateManyMutationInput {
  return {
    currentState: state,
    stateChangedAt: now,
    ...timestampMutationForState(
      evidence,
      state,
      now
    ),
  };
}

function canonicalTransitionTargets(
  currentState: GuestJourneyState,
  expectedState: GuestJourneyState
): GuestJourneyState[] {
  if (
    expectedState ===
    GuestJourneyState.JOURNEY_CANCELLED
  ) {
    return [
      GuestJourneyState.JOURNEY_CANCELLED,
    ];
  }

  const currentIndex =
    CANONICAL_GUEST_JOURNEY_STATE_ORDER.findIndex(
      (state) => state === currentState
    );
  const expectedIndex =
    CANONICAL_GUEST_JOURNEY_STATE_ORDER.findIndex(
      (state) => state === expectedState
    );

  if (
    currentIndex < 0 ||
    expectedIndex < 0 ||
    currentIndex >= expectedIndex
  ) {
    return [];
  }

  return [
    ...CANONICAL_GUEST_JOURNEY_STATE_ORDER.slice(
      currentIndex + 1,
      expectedIndex + 1
    ),
  ];
}

async function readJourney(
  tx:
    GuestJourneyReconcilerTransactionClient,
  reservationId: string
): Promise<JourneyRecord | null> {
  return tx.guestJourney.findUnique({
    where: {
      reservationId,
    },
    select: {
      id: true,
      currentState: true,
    },
  });
}

function buildAuditEntry(input: {
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
  metadata?: Record<string, unknown>;
}): AuditEntry {
  return {
    engine: "GUEST_JOURNEY",
    decisionId: input.decisionId,
    entityType: "RESERVATION",
    entityId:
      input.evidence.reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary: input.summary,
    reason: input.reason,
    startedAt: input.now,
    completedAt: input.now,
    durationMs: 0,
    decisions: [
      {
        engine: "GUEST_JOURNEY",
        rule: input.rule,
        label: input.label,
        previousValue:
          input.previousValue,
        newValue: input.newValue,
        applied: true,
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
      runtime:
        "GUEST_JOURNEY_INTERNAL_RECONCILE",
      coordinationIntentWritesEnabled:
        false,
      ownerEngineExecutionEnabled:
        false,
      operationalIssueWritesEnabled:
        false,
      organizationId:
        input.evidence.reservation
          .organizationId,
      propertyId:
        input.evidence.reservation
          .propertyId,
      reservationId:
        input.evidence.reservation.id,
      evidenceFingerprint:
        input.evaluation
          .evidenceFingerprint,
      expectedState:
        input.evaluation.expectedState,
      comparison:
        input.evaluation.comparison,
      ...input.metadata,
    },
  };
}

async function reconstructMissingJourney(
  tx:
    GuestJourneyReconcilerTransactionClient,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date,
  dependencies:
    GuestJourneyReconcilerDependencies
): Promise<{
  journey: JourneyRecord;
  created: boolean;
}> {
  const createResult =
    await tx.guestJourney.createMany({
      data: [
        buildReconstructionData(
          evidence,
          evaluation.expectedState,
          now
        ),
      ],
      skipDuplicates: true,
    });
  const journey = await readJourney(
    tx,
    evidence.reservation.id
  );

  if (!journey) {
    throw new Error(
      "GUEST_JOURNEY_RECONCILER_CREATE_MISSING_JOURNEY_FAILED"
    );
  }

  if (createResult.count === 1) {
    await dependencies.persistAudit(
      tx,
      buildAuditEntry({
        decisionId: [
          "guest-journey",
          "internal-reconcile",
          journey.id,
          "reconstructed",
          evaluation.evidenceFingerprint,
        ].join(":"),
        summary:
          "Guest Journey reconstructed from canonical persisted evidence.",
        reason:
          "No Guest Journey existed, so the internal reconciler created it at the highest lifecycle state proven by persisted evidence.",
        rule:
          "RECONSTRUCT_FROM_EVIDENCE",
        label:
          "Reconstruct Guest Journey",
        previousValue: null,
        newValue:
          evaluation.expectedState,
        evidence,
        evaluation,
        now,
        metadata: {
          journeyId: journey.id,
          reconstructedState:
            evaluation.expectedState,
        },
      })
    );
  }

  return {
    journey,
    created:
      createResult.count === 1,
  };
}

async function repairCurrentStateTimestamp(
  tx:
    GuestJourneyReconcilerTransactionClient,
  journey: JourneyRecord,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date,
  dependencies:
    GuestJourneyReconcilerDependencies
): Promise<boolean> {
  const repairEffectiveAt =
    journey.currentState ===
      GuestJourneyState
        .JOURNEY_COMPLETED
      ? evidence.persistedJourney
          .stateChangedAt ?? now
      : now;
  const mutation =
    timestampMutationForState(
      evidence,
      journey.currentState,
      repairEffectiveAt
    );
  const field = Object.keys(
    mutation
  )[0] as
    | "verificationCompletedAt"
    | "accessScheduledAt"
    | "readyForArrivalAt"
    | "stayActiveAt"
    | "checkoutDueAt"
    | "completedAt"
    | "cancelledAt"
    | undefined;

  if (!field) {
    return false;
  }

  const result =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState:
          journey.currentState,
        [field]: null,
      },
      data: mutation,
    });

  if (result.count !== 1) {
    return false;
  }

  await dependencies.persistAudit(
    tx,
    buildAuditEntry({
      decisionId: [
        "guest-journey",
        "internal-reconcile",
        journey.id,
        "repair-timestamp",
        journey.currentState,
        evaluation.evidenceFingerprint,
      ].join(":"),
      summary:
        `Guest Journey repaired the missing ${journey.currentState} lifecycle timestamp.`,
      reason:
        "The lifecycle state was already persisted and its missing timestamp could be reconstructed safely from canonical evidence.",
      rule:
        "REPAIR_GUEST_JOURNEY_TIMESTAMP",
      label:
        "Repair Guest Journey timestamp",
      previousValue: null,
      newValue: mutation[field],
      evidence,
      evaluation,
      now,
      metadata: {
        journeyId: journey.id,
        currentState:
          journey.currentState,
        repairedField: field,
      },
    })
  );

  return true;
}

async function advanceCanonicalTransitions(
  tx:
    GuestJourneyReconcilerTransactionClient,
  journey: JourneyRecord,
  evidence:
    GuestJourneyEvidenceSnapshot,
  evaluation:
    CanonicalJourneyEvaluation,
  now: Date,
  dependencies:
    GuestJourneyReconcilerDependencies
): Promise<{
  finalState: GuestJourneyState;
  transitionCount: number;
  compareAndSetLost: boolean;
}> {
  const targets =
    canonicalTransitionTargets(
      journey.currentState,
      evaluation.expectedState
    );
  let currentState =
    journey.currentState;
  let transitionCount = 0;

  for (const targetState of targets) {
    const result =
      await tx.guestJourney.updateMany({
        where: {
          id: journey.id,
          currentState,
        },
        data: buildTransitionData(
          evidence,
          targetState,
          now
        ),
      });

    if (result.count !== 1) {
      const winner =
        await tx.guestJourney.findUnique({
          where: {
            id: journey.id,
          },
          select: {
            currentState: true,
          },
        });

      if (!winner) {
        throw new Error(
          "GUEST_JOURNEY_RECONCILER_COMPARE_AND_SET_TARGET_MISSING"
        );
      }

      return {
        finalState:
          winner.currentState,
        transitionCount,
        compareAndSetLost: true,
      };
    }

    await dependencies.persistAudit(
      tx,
      buildAuditEntry({
        decisionId: [
          "guest-journey",
          "internal-reconcile",
          journey.id,
          currentState,
          "to",
          targetState,
        ].join(":"),
        summary:
          `Guest Journey advanced from ${currentState} to ${targetState}.`,
        reason:
          "The canonical evaluator determined that persisted evidence proves the next lifecycle state.",
        rule:
          "ADVANCE_CANONICAL_GUEST_JOURNEY",
        label:
          "Advance Guest Journey",
        previousValue: currentState,
        newValue: targetState,
        evidence,
        evaluation,
        now,
        metadata: {
          journeyId: journey.id,
          fromState: currentState,
          toState: targetState,
          stateEffectiveAt:
            stateEffectiveAt(
              evidence,
              targetState,
              now
            ),
        },
      })
    );

    currentState = targetState;
    transitionCount += 1;
  }

  return {
    finalState: currentState,
    transitionCount,
    compareAndSetLost: false,
  };
}

export async function reconcileGuestJourneyInTransaction(
  tx:
    GuestJourneyReconcilerTransactionClient,
  reservationId: string,
  now: Date,
  scope: GuestJourneyEvidenceScope,
  dependencies:
    GuestJourneyReconcilerDependencies =
      DEFAULT_DEPENDENCIES
): Promise<
  GuestJourneyInternalReconcileResult
> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );
  const evaluatedAt = requireValidDate(
    now,
    "now"
  );
  const expectedScope =
    requireScope(scope);
  const evidence =
    await dependencies.loadEvidence(
      tx,
      cleanReservationId,
      evaluatedAt,
      expectedScope
    );
  const evaluation =
    dependencies.evaluate(evidence);
  const initialPersistedState =
    evaluation.persistedState;
  const actions:
    GuestJourneyInternalReconcileAction[] =
    [];
  let journey:
    JourneyRecord | null =
    evidence.persistedJourney.exists &&
    evidence.persistedJourney.id &&
    evidence.persistedJourney.currentState
      ? {
          id:
            evidence.persistedJourney.id,
          currentState:
            evidence.persistedJourney
              .currentState,
        }
      : null;

  if (
    evaluation.comparison === "MISSING"
  ) {
    const reconstructed =
      await reconstructMissingJourney(
        tx,
        evidence,
        evaluation,
        evaluatedAt,
        dependencies
      );
    journey = reconstructed.journey;

    if (reconstructed.created) {
      actions.push({
        code:
          "CREATE_JOURNEY_FROM_EVIDENCE",
        detail:
          `Created Guest Journey directly at ${journey.currentState}.`,
        metadata: {
          journeyId: journey.id,
          expectedState:
            evaluation.expectedState,
        },
      });
    } else {
      actions.push({
        code:
          "COMPARE_AND_SET_LOST",
        detail:
          "Another writer created the missing Guest Journey first; the reconciler preserved the winner and stopped using stale evidence.",
        metadata: {
          journeyId: journey.id,
          winnerState:
            journey.currentState,
        },
      });
    }

    return {
      reservationId:
        evidence.reservation.id,
      journeyId: journey.id,
      evaluation,
      initialPersistedState,
      finalPersistedState:
        journey.currentState,
      actions,
      proposedCoordinationIntentCount:
        evaluation
          .requiredCoordinationIntents
          .length,
      coordinationIntentWrites: 0,
      operationalIssueWrites: 0,
    };
  }

  if (!journey) {
    throw new Error(
      "GUEST_JOURNEY_RECONCILER_PERSISTED_JOURNEY_IDENTITY_MISSING"
    );
  }

  if (
    evaluation.comparison ===
    "AHEAD_OF_EVIDENCE"
  ) {
    actions.push({
      code: "PRESERVE_AHEAD_STATE",
      detail:
        "Persisted Guest Journey is ahead of canonical evidence; E3 did not regress or rewrite it.",
    });
  } else if (
    evaluation.comparison ===
    "TERMINAL_CONTRADICTION"
  ) {
    actions.push({
      code: "PRESERVE_TERMINAL_STATE",
      detail:
        "Persisted terminal Guest Journey contradicts current evidence; E3 preserved the terminal state.",
    });
  } else {
    const timestampRepairRequired =
      evaluation.requiredInternalRepairs.some(
        (repair) =>
          repair.code ===
          "REPAIR_GUEST_JOURNEY_TIMESTAMP"
      );

    if (timestampRepairRequired) {
      const repaired =
        await repairCurrentStateTimestamp(
          tx,
          journey,
          evidence,
          evaluation,
          evaluatedAt,
          dependencies
        );

      if (repaired) {
        actions.push({
          code:
            "REPAIR_CANONICAL_TIMESTAMP",
          detail:
            `Repaired the canonical timestamp for ${journey.currentState}.`,
        });
      }
    }

    if (
      evaluation.comparison === "BEHIND"
    ) {
      const advanced =
        await advanceCanonicalTransitions(
          tx,
          journey,
          evidence,
          evaluation,
          evaluatedAt,
          dependencies
        );
      journey = {
        id: journey.id,
        currentState:
          advanced.finalState,
      };

      if (advanced.transitionCount > 0) {
        actions.push({
          code:
            "ADVANCE_CANONICAL_TRANSITION",
          detail:
            `Applied ${advanced.transitionCount} evidence-backed Guest Journey transition(s).`,
          metadata: {
            transitionCount:
              advanced.transitionCount,
            finalState:
              advanced.finalState,
          },
        });
      }

      if (advanced.compareAndSetLost) {
        actions.push({
          code:
            "COMPARE_AND_SET_LOST",
          detail:
            "A compare-and-set transition lost to another writer; E3 preserved the winner and stopped.",
          metadata: {
            winnerState:
              advanced.finalState,
          },
        });
      }
    }
  }

  if (actions.length === 0) {
    actions.push({
      code: "NO_ACTION",
      detail:
        "Guest Journey is aligned with canonical persisted evidence and requires no internal repair.",
    });
  }

  return {
    reservationId:
      evidence.reservation.id,
    journeyId: journey.id,
    evaluation,
    initialPersistedState,
    finalPersistedState:
      journey.currentState,
    actions,
    proposedCoordinationIntentCount:
      evaluation
        .requiredCoordinationIntents.length,
    coordinationIntentWrites: 0,
    operationalIssueWrites: 0,
  };
}

export async function reconcileGuestJourney(
  prisma: PrismaClient,
  reservationId: string,
  options: {
    now?: Date;
    scope: GuestJourneyEvidenceScope;
  }
): Promise<
  GuestJourneyInternalReconcileResult
> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );
  const now = requireValidDate(
    options.now ?? new Date(),
    "now"
  );
  const scope = requireScope(
    options.scope
  );
  const advisoryLockKey =
    `${GUEST_JOURNEY_LOCK_PREFIX}${cleanReservationId}`;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${advisoryLockKey}, 0)
          )
        `
      );

      return reconcileGuestJourneyInTransaction(
        tx,
        cleanReservationId,
        now,
        scope
      );
    }
  );
}
