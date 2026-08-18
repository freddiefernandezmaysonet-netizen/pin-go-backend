import { createHash } from "node:crypto";

import {
  GuestJourneyState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import type { AuditEntry } from "../apms/audit-types";
import {
  ApmsAuditDecisionIdConflictError,
  persistAuditEntry,
} from "../apms/audit-persistence.service";
import type {
  CanonicalJourneyEvaluation,
  GuestJourneyStateComparison,
} from "./guest-journey-contract";
import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";
import {
  loadGuestJourneyEvidence,
} from "./guest-journey-evidence.service";
import type {
  GuestJourneyShadowConfig,
} from "./guest-journey-shadow.config";

export type GuestJourneyShadowClient = Pick<
  PrismaClient,
  "reservation" | "apmsAuditEntry"
>;

export type GuestJourneyShadowMetrics = {
  enabled: boolean;
  selected: number;
  evaluated: number;
  errors: number;
  auditCreated: number;
  auditDeduplicated: number;
  comparisonCounts: Record<
    GuestJourneyStateComparison,
    number
  >;
  expectedStateCounts: Partial<
    Record<GuestJourneyState, number>
  >;
  blockerCount: number;
  inconsistencyCount: number;
  criticalInconsistencyCount: number;
  errorCodeCounts: Record<string, number>;
  durationMs: number;
  nextCursor: string | null;
};

export type GuestJourneyShadowLog = {
  event: "GUEST_JOURNEY_SHADOW_CYCLE";
  metrics: GuestJourneyShadowMetrics;
};

type ShadowCandidate = {
  id: string;
  propertyId: string;
  property: {
    organizationId: string;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyComparisonCounts(): Record<
  GuestJourneyStateComparison,
  number
> {
  return {
    MISSING: 0,
    ALIGNED: 0,
    BEHIND: 0,
    AHEAD_OF_EVIDENCE: 0,
    TERMINAL_CONTRADICTION: 0,
  };
}

function requireValidNow(now: Date): Date {
  if (
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    throw new Error(
      "GUEST_JOURNEY_SHADOW_NOW_INVALID"
    );
  }

  return now;
}

function requireSafeConfig(
  config: GuestJourneyShadowConfig
): void {
  if (
    !Number.isInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > 50
  ) {
    throw new Error(
      "GUEST_JOURNEY_SHADOW_BATCH_SIZE_INVALID"
    );
  }

  if (
    !Number.isInteger(config.horizonDays) ||
    config.horizonDays < 1 ||
    config.horizonDays > 365
  ) {
    throw new Error(
      "GUEST_JOURNEY_SHADOW_HORIZON_DAYS_INVALID"
    );
  }

  if (
    !Number.isInteger(config.lookbackDays) ||
    config.lookbackDays < 1 ||
    config.lookbackDays > 30
  ) {
    throw new Error(
      "GUEST_JOURNEY_SHADOW_LOOKBACK_DAYS_INVALID"
    );
  }

  if (
    config.enabled &&
    config.organizationIds.length === 0 &&
    config.propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_SHADOW_SCOPE_REQUIRED"
    );
  }
}

function buildCandidateWhere(input: {
  config: GuestJourneyShadowConfig;
  now: Date;
}): Prisma.ReservationWhereInput {
  const earliestRelevantAt = new Date(
    input.now.getTime() -
      input.config.lookbackDays * DAY_MS
  );
  const latestRelevantAt = new Date(
    input.now.getTime() +
      input.config.horizonDays * DAY_MS
  );
  const scopes: Prisma.ReservationWhereInput[] = [];

  if (input.config.propertyIds.length > 0) {
    scopes.push({
      propertyId: {
        in: input.config.propertyIds,
      },
    });
  }

  if (
    input.config.organizationIds.length > 0
  ) {
    scopes.push({
      property: {
        is: {
          organizationId: {
            in:
              input.config.organizationIds,
          },
        },
      },
    });
  }

  return {
    AND: [
      {
        OR: scopes,
      },
      {
        OR: [
          {
            status: ReservationStatus.ACTIVE,
            checkIn: {
              lte: latestRelevantAt,
            },
            checkOut: {
              gte: earliestRelevantAt,
            },
          },
          {
            status:
              ReservationStatus.CANCELLED,
            OR: [
              {
                cancelledAt: {
                  gte: earliestRelevantAt,
                },
              },
              {
                cancelledAt: null,
                updatedAt: {
                  gte: earliestRelevantAt,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function selectShadowCandidates(
  prisma: GuestJourneyShadowClient,
  input: {
    config: GuestJourneyShadowConfig;
    now: Date;
    cursor: string | null;
  }
): Promise<ShadowCandidate[]> {
  return prisma.reservation.findMany({
    where: buildCandidateWhere(input),
    orderBy: {
      id: "asc",
    },
    take: input.config.batchSize,
    ...(input.cursor
      ? {
          cursor: {
            id: input.cursor,
          },
          skip: 1,
        }
      : {}),
    select: {
      id: true,
      propertyId: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });
}

function stableEvaluationProjection(
  evaluation: CanonicalJourneyEvaluation
) {
  return {
    contractVersion:
      evaluation.contractVersion,
    reservationId:
      evaluation.reservationId,
    evidenceFingerprint:
      evaluation.evidenceFingerprint,
    temporalPhase:
      evaluation.temporalPhase,
    expectedState:
      evaluation.expectedState,
    persistedState:
      evaluation.persistedState,
    comparison:
      evaluation.comparison,
    stateReasonCode:
      evaluation.stateReasonCode,
    terminal:
      evaluation.terminal,
    blockerCodes:
      evaluation.blockers.map(
        (blocker) => blocker.code
      ),
    inconsistencies:
      evaluation.inconsistencies.map(
        (inconsistency) => ({
          code: inconsistency.code,
          severity:
            inconsistency.severity,
        })
      ),
    repairCodes:
      evaluation.requiredInternalRepairs.map(
        (repair) => repair.code
      ),
    proposedIntents:
      evaluation.requiredCoordinationIntents.map(
        (intent) => ({
          intentType: intent.intentType,
          targetEngine:
            intent.targetEngine,
          reasonCode: intent.reasonCode,
          expectedOutcomeCode:
            intent.expectedOutcomeCode,
        })
      ),
  };
}

function buildShadowDecisionId(
  evaluation: CanonicalJourneyEvaluation
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        stableEvaluationProjection(
          evaluation
        )
      )
    )
    .digest("hex");

  return [
    "guest-journey",
    "shadow",
    evaluation.reservationId,
    digest,
  ].join(":");
}

function buildShadowAuditEntry(input: {
  candidate: ShadowCandidate;
  evaluation: CanonicalJourneyEvaluation;
  observedAt: Date;
}): AuditEntry {
  const criticalInconsistency =
    input.evaluation.inconsistencies.some(
      (inconsistency) =>
        inconsistency.severity ===
        "CRITICAL"
    );
  const warning =
    input.evaluation.comparison !==
      "ALIGNED" ||
    input.evaluation.blockers.length > 0 ||
    input.evaluation.inconsistencies.length >
      0;

  return {
    engine: "GUEST_JOURNEY",
    decisionId: buildShadowDecisionId(
      input.evaluation
    ),
    entityType: "RESERVATION",
    entityId: input.candidate.id,
    eventType: "DECISION_CREATED",
    status: "SUCCESS",
    severity: criticalInconsistency
      ? "CRITICAL"
      : warning
        ? "WARNING"
        : "INFO",
    summary:
      `Guest Journey shadow evaluation: ${input.evaluation.comparison}.`,
    reason:
      input.evaluation.stateReason,
    startedAt: input.observedAt,
    completedAt: input.observedAt,
    durationMs: 0,
    decisions: [
      {
        engine: "GUEST_JOURNEY",
        rule:
          input.evaluation.stateReasonCode,
        label:
          "Evaluate expected Guest Journey state in shadow mode",
        previousValue:
          input.evaluation.persistedState,
        newValue:
          input.evaluation.expectedState,
        applied: false,
        metadata: {
          shadow: true,
          comparison:
            input.evaluation.comparison,
        },
      },
    ],
    metadata: {
      shadow: true,
      runtimeWritesEnabled: false,
      organizationId:
        input.candidate.property
          .organizationId,
      propertyId:
        input.candidate.propertyId,
      reservationId:
        input.candidate.id,
      evaluatorVersion:
        input.evaluation.contractVersion,
      evidenceFingerprint:
        input.evaluation
          .evidenceFingerprint,
      temporalPhase:
        input.evaluation.temporalPhase,
      expectedState:
        input.evaluation.expectedState,
      persistedState:
        input.evaluation.persistedState,
      comparison:
        input.evaluation.comparison,
      blockerCodes:
        input.evaluation.blockers.map(
          (blocker) => blocker.code
        ),
      inconsistencyCodes:
        input.evaluation.inconsistencies.map(
          (inconsistency) =>
            inconsistency.code
        ),
      proposedIntentTypes:
        input.evaluation
          .requiredCoordinationIntents
          .map((intent) => ({
            intentType:
              intent.intentType,
            targetEngine:
              intent.targetEngine,
          })),
    },
  };
}

async function persistShadowAudit(
  prisma: GuestJourneyShadowClient,
  entry: AuditEntry
): Promise<"CREATED" | "DEDUPLICATED"> {
  const existing =
    await prisma.apmsAuditEntry.findUnique({
      where: {
        decisionId: entry.decisionId,
      },
      select: {
        id: true,
      },
    });

  if (existing) {
    return "DEDUPLICATED";
  }

  try {
    await persistAuditEntry(prisma, entry);
    return "CREATED";
  } catch (error) {
    if (
      error instanceof
      ApmsAuditDecisionIdConflictError
    ) {
      return "DEDUPLICATED";
    }

    throw error;
  }
}

function toErrorCode(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : String(error);
  const code = message
    .split(":", 1)[0]
    .trim()
    .replace(/[^A-Z0-9_]/gi, "_")
    .toUpperCase();

  return code || "UNKNOWN_ERROR";
}

export async function runGuestJourneyShadowCycle(
  prisma: GuestJourneyShadowClient,
  config: GuestJourneyShadowConfig,
  options: {
    now?: Date;
    cursor?: string | null;
    logger?: (
      entry: GuestJourneyShadowLog
    ) => void;
  } = {}
): Promise<GuestJourneyShadowMetrics> {
  const startedAtMs = Date.now();
  const comparisonCounts =
    emptyComparisonCounts();
  const metrics: GuestJourneyShadowMetrics = {
    enabled: config.enabled,
    selected: 0,
    evaluated: 0,
    errors: 0,
    auditCreated: 0,
    auditDeduplicated: 0,
    comparisonCounts,
    expectedStateCounts: {},
    blockerCount: 0,
    inconsistencyCount: 0,
    criticalInconsistencyCount: 0,
    errorCodeCounts: {},
    durationMs: 0,
    nextCursor: null,
  };

  requireSafeConfig(config);

  if (!config.enabled) {
    metrics.durationMs =
      Date.now() - startedAtMs;
    options.logger?.({
      event:
        "GUEST_JOURNEY_SHADOW_CYCLE",
      metrics,
    });
    return metrics;
  }

  const now = requireValidNow(
    options.now ?? new Date()
  );
  const candidates =
    await selectShadowCandidates(prisma, {
      config,
      now,
      cursor:
        String(options.cursor ?? "").trim() ||
        null,
    });

  metrics.selected = candidates.length;
  metrics.nextCursor =
    candidates.length === config.batchSize
      ? candidates.at(-1)?.id ?? null
      : null;

  for (const candidate of candidates) {
    try {
      const evidence =
        await loadGuestJourneyEvidence(
          prisma,
          candidate.id,
          now,
          {
            organizationId:
              candidate.property
                .organizationId,
            propertyId:
              candidate.propertyId,
          }
        );
      const evaluation =
        evaluateCanonicalGuestJourney(
          evidence
        );

      metrics.evaluated += 1;
      metrics.comparisonCounts[
        evaluation.comparison
      ] += 1;
      metrics.expectedStateCounts[
        evaluation.expectedState
      ] =
        (metrics.expectedStateCounts[
          evaluation.expectedState
        ] ?? 0) + 1;
      metrics.blockerCount +=
        evaluation.blockers.length;
      metrics.inconsistencyCount +=
        evaluation.inconsistencies.length;
      metrics.criticalInconsistencyCount +=
        evaluation.inconsistencies.filter(
          (inconsistency) =>
            inconsistency.severity ===
            "CRITICAL"
        ).length;

      const auditResult =
        await persistShadowAudit(
          prisma,
          buildShadowAuditEntry({
            candidate,
            evaluation,
            observedAt: now,
          })
        );

      if (auditResult === "CREATED") {
        metrics.auditCreated += 1;
      } else {
        metrics.auditDeduplicated += 1;
      }
    } catch (error) {
      metrics.errors += 1;
      const errorCode = toErrorCode(error);
      metrics.errorCodeCounts[errorCode] =
        (metrics.errorCodeCounts[
          errorCode
        ] ?? 0) + 1;
    }
  }

  metrics.durationMs =
    Date.now() - startedAtMs;
  options.logger?.({
    event: "GUEST_JOURNEY_SHADOW_CYCLE",
    metrics,
  });

  return metrics;
}
