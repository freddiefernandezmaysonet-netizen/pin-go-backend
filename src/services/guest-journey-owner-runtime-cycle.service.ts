import {
  randomBytes,
} from "node:crypto";

import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import {
  executeGuestJourneyAccessEvaluationHandler,
} from "./guest-journey-access-evaluation-handler.service";
import type {
  GuestJourneyOwnerRuntimeConfig,
} from "./guest-journey-owner-runtime.config";
import {
  claimGuestJourneyAccessEvaluationIntent,
  completeGuestJourneyAccessEvaluationIntent,
  normalizeOwnerRuntimeError,
} from "./guest-journey-owner-runtime.service";

export type GuestJourneyOwnerRuntimeCycleMetrics = {
  enabled: boolean;
  selected: number;
  claimAttempts: number;
  claimed: number;
  recoveredStaleLeases: number;
  claimRaces: number;
  liveLeases: number;
  executed: number;
  succeeded: number;
  waitingForEvidence: number;
  retryable: number;
  exhausted: number;
  errors: number;
  externalSideEffects: 0;
  operationalIssueWrites: 0;
  errorCodeCounts: Record<string, number>;
  durationMs: number;
};

export type GuestJourneyOwnerRuntimeCycleLog = {
  event:
    "GUEST_JOURNEY_OWNER_RUNTIME_CYCLE";
  metrics:
    GuestJourneyOwnerRuntimeCycleMetrics;
};

type CycleDependencies = {
  claim:
    typeof claimGuestJourneyAccessEvaluationIntent;
  execute:
    typeof executeGuestJourneyAccessEvaluationHandler;
  complete:
    typeof completeGuestJourneyAccessEvaluationIntent;
  leaseTokenFactory: () => string;
  clock: () => Date;
};

const DEFAULT_DEPENDENCIES:
  CycleDependencies = {
    claim:
      claimGuestJourneyAccessEvaluationIntent,
    execute:
      executeGuestJourneyAccessEvaluationHandler,
    complete:
      completeGuestJourneyAccessEvaluationIntent,
    leaseTokenFactory: () =>
      randomBytes(32).toString(
        "base64url"
      ),
    clock: () => new Date(),
  };

function requireSafeConfig(
  config:
    GuestJourneyOwnerRuntimeConfig
): void {
  if (
    config.enabled &&
    config.organizationIds.length === 0 &&
    config.propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_OWNER_RUNTIME_SCOPE_REQUIRED"
    );
  }
}

function incrementError(
  metrics:
    GuestJourneyOwnerRuntimeCycleMetrics,
  error: unknown
): void {
  metrics.errors += 1;
  const normalized =
    normalizeOwnerRuntimeError(error);
  metrics.errorCodeCounts[
    normalized.code
  ] =
    (metrics.errorCodeCounts[
      normalized.code
    ] ?? 0) + 1;
}

async function selectCandidates(
  prisma: PrismaClient,
  config:
    GuestJourneyOwnerRuntimeConfig,
  now: Date
): Promise<Array<{ id: string }>> {
  const scopeFilters = [
    ...(config.organizationIds.length > 0
      ? [
          {
            reservation: {
              is: {
                property: {
                  is: {
                    organizationId: {
                      in: config.organizationIds,
                    },
                  },
                },
              },
            },
          },
        ]
      : []),
    ...(config.propertyIds.length > 0
      ? [
          {
            reservation: {
              is: {
                propertyId: {
                  in: config.propertyIds,
                },
              },
            },
          },
        ]
      : []),
  ];

  return prisma
    .guestJourneyCoordinationIntent
    .findMany({
      where: {
        targetEngine: "ACCESS",
        intentType:
          "REQUEST_ACCESS_EVALUATION",
        AND: [
          {
            OR: scopeFilters,
          },
          {
            OR: [
              {
                status: {
                  in: [
                    GuestJourneyCoordinationIntentStatus
                      .PENDING,
                    GuestJourneyCoordinationIntentStatus
                      .RETRYABLE,
                  ],
                },
                OR: [
                  {
                    nextActionAt: null,
                  },
                  {
                    nextActionAt: {
                      lte: now,
                    },
                  },
                ],
              },
              {
                status:
                  GuestJourneyCoordinationIntentStatus
                    .CLAIMED,
                leaseExpiresAt: {
                  lte: now,
                },
              },
            ],
          },
        ],
      },
      orderBy: [
        {
          nextActionAt: "asc",
        },
        {
          createdAt: "asc",
        },
        {
          id: "asc",
        },
      ],
      take: config.batchSize,
      select: {
        id: true,
      },
    });
}

export async function runGuestJourneyOwnerRuntimeCycle(
  prisma: PrismaClient,
  config:
    GuestJourneyOwnerRuntimeConfig,
  options: {
    now?: Date;
    logger?: (
      entry:
        GuestJourneyOwnerRuntimeCycleLog
    ) => void;
    dependencies?: Partial<
      CycleDependencies
    >;
  } = {}
): Promise<GuestJourneyOwnerRuntimeCycleMetrics> {
  const startedAtMs = Date.now();
  const metrics:
    GuestJourneyOwnerRuntimeCycleMetrics = {
    enabled: config.enabled,
    selected: 0,
    claimAttempts: 0,
    claimed: 0,
    recoveredStaleLeases: 0,
    claimRaces: 0,
    liveLeases: 0,
    executed: 0,
    succeeded: 0,
    waitingForEvidence: 0,
    retryable: 0,
    exhausted: 0,
    errors: 0,
    externalSideEffects: 0,
    operationalIssueWrites: 0,
    errorCodeCounts: {},
    durationMs: 0,
  };

  requireSafeConfig(config);

  if (!config.enabled) {
    metrics.durationMs =
      Date.now() - startedAtMs;
    options.logger?.({
      event:
        "GUEST_JOURNEY_OWNER_RUNTIME_CYCLE",
      metrics,
    });
    return metrics;
  }

  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  const now = options.now ??
    dependencies.clock();
  const candidates =
    await selectCandidates(
      prisma,
      config,
      now
    );

  metrics.selected =
    candidates.length;

  for (const candidate of candidates) {
    metrics.claimAttempts += 1;

    try {
      const claimResult =
        await dependencies.claim(
          prisma,
          {
            intentId: candidate.id,
            leaseToken:
              dependencies
                .leaseTokenFactory(),
            scope: {
              organizationIds:
                config.organizationIds,
              propertyIds:
                config.propertyIds,
            },
            leaseMs: config.leaseMs,
            maxClaims:
              config.maxClaims,
            now,
          }
        );

      if (!claimResult.claimed) {
        if (
          claimResult.reason ===
          "CLAIM_RACE"
        ) {
          metrics.claimRaces += 1;
        } else if (
          claimResult.reason ===
          "LIVE_LEASE"
        ) {
          metrics.liveLeases += 1;
        } else if (
          claimResult.reason ===
          "EXHAUSTED"
        ) {
          metrics.exhausted += 1;
        }

        continue;
      }

      metrics.claimed += 1;
      if (
        claimResult
          .recoveredStaleLease
      ) {
        metrics.recoveredStaleLeases +=
          1;
      }

      let completion;

      try {
        const execution =
          await dependencies.execute(
            prisma,
            claimResult.claim,
            {
              now:
                dependencies.clock(),
            }
          );

        metrics.executed += 1;
        completion =
          execution.completion;
      } catch (error) {
        const normalized =
          normalizeOwnerRuntimeError(
            error
          );
        completion = {
          kind: "RETRYABLE" as const,
          outcomeEvidenceFingerprint:
            claimResult.claim
              .inputEvidenceFingerprint,
          errorCode: normalized.code,
          errorDetail:
            normalized.detail,
        };
      }

      const completed =
        await dependencies.complete(
          prisma,
          {
            claim:
              claimResult.claim,
            completion,
            maxClaims:
              config.maxClaims,
            retryBaseMs:
              config.retryBaseMs,
            now:
              dependencies.clock(),
          }
        );

      if (
        completed.status ===
        "SUCCEEDED"
      ) {
        metrics.succeeded += 1;
      } else if (
        completed.status ===
        "WAITING_FOR_EVIDENCE"
      ) {
        metrics.waitingForEvidence += 1;
      } else if (
        completed.status ===
        "RETRYABLE"
      ) {
        metrics.retryable += 1;
      } else {
        metrics.exhausted += 1;
      }
    } catch (error) {
      incrementError(metrics, error);
    }
  }

  metrics.durationMs =
    Date.now() - startedAtMs;
  options.logger?.({
    event:
      "GUEST_JOURNEY_OWNER_RUNTIME_CYCLE",
    metrics,
  });

  return metrics;
}
