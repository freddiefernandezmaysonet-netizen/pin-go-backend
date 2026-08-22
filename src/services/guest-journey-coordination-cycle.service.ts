import {
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  materializeGuestJourneyCoordinationIntents,
} from "./guest-journey-coordination-intent.service";
import type {
  GuestJourneyCoordinationAction,
  GuestJourneyCoordinationActionCode,
} from "./guest-journey-coordination-intent.service";
import type {
  GuestJourneyCoordinationConfig,
} from "./guest-journey-coordination.config";

export type GuestJourneyCoordinationCycleMetrics = {
  enabled: boolean;
  selected: number;
  evaluated: number;
  errors: number;
  journeyMissing: number;
  intentsProposed: number;
  intentsCreated: number;
  intentsReactivated: number;
  intentsDeduplicated: number;
  intentsSuperseded: number;
  activeClaimsPreserved: number;
  compareAndSetLost: number;
  coordinationIntentWrites: number;
  operationalIssueWrites: 0;
  ownerEngineExecutions: 0;
  actionCounts: Partial<
    Record<
      GuestJourneyCoordinationActionCode,
      number
    >
  >;
  errorCodeCounts: Record<string, number>;
  durationMs: number;
  nextCursor: string | null;
};

export type GuestJourneyCoordinationCycleLog = {
  event:
    "GUEST_JOURNEY_COORDINATION_INTENTS_CYCLE";
  metrics:
    GuestJourneyCoordinationCycleMetrics;
};

type CoordinationCandidate = {
  id: string;
  propertyId: string;
  property: {
    organizationId: string;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

function requireValidNow(now: Date): Date {
  if (
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_CYCLE_NOW_INVALID"
    );
  }

  return now;
}

function requireSafeConfig(
  config:
    GuestJourneyCoordinationConfig
): void {
  if (
    !Number.isInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > 50
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_INTENTS_BATCH_SIZE_INVALID"
    );
  }

  if (
    !Number.isInteger(config.horizonDays) ||
    config.horizonDays < 1 ||
    config.horizonDays > 365
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_INTENTS_HORIZON_DAYS_INVALID"
    );
  }

  if (
    !Number.isInteger(config.lookbackDays) ||
    config.lookbackDays < 1 ||
    config.lookbackDays > 30
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_INTENTS_LOOKBACK_DAYS_INVALID"
    );
  }

  if (
    config.enabled &&
    config.organizationIds.length === 0 &&
    config.propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_COORDINATION_INTENTS_SCOPE_REQUIRED"
    );
  }
}

function buildCandidateWhere(input: {
  config:
    GuestJourneyCoordinationConfig;
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
  const scopes:
    Prisma.ReservationWhereInput[] = [];

  if (
    input.config.propertyIds.length > 0
  ) {
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
            status:
              ReservationStatus.ACTIVE,
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
                  gte:
                    earliestRelevantAt,
                },
              },
              {
                cancelledAt: null,
                updatedAt: {
                  gte:
                    earliestRelevantAt,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function selectCandidates(
  prisma: PrismaClient,
  input: {
    config:
      GuestJourneyCoordinationConfig;
    now: Date;
    cursor: string | null;
  }
): Promise<CoordinationCandidate[]> {
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

function toErrorCode(error: unknown): string {
  const structuredCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown })
      .code === "string"
      ? (error as { code: string }).code
      : null;
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

  return code || "UNKNOWN_ERROR";
}

function incrementAction(
  metrics:
    GuestJourneyCoordinationCycleMetrics,
  action:
    GuestJourneyCoordinationAction
): void {
  metrics.actionCounts[action.code] =
    (metrics.actionCounts[action.code] ??
      0) + 1;

  if (action.code === "JOURNEY_MISSING") {
    metrics.journeyMissing += 1;
  }
}

export async function runGuestJourneyCoordinationCycle(
  prisma: PrismaClient,
  config: GuestJourneyCoordinationConfig,
  options: {
    now?: Date;
    cursor?: string | null;
    materialize?:
      typeof materializeGuestJourneyCoordinationIntents;
    logger?: (
      entry:
        GuestJourneyCoordinationCycleLog
    ) => void;
  } = {}
): Promise<GuestJourneyCoordinationCycleMetrics> {
  const startedAtMs = Date.now();
  const metrics:
    GuestJourneyCoordinationCycleMetrics = {
    enabled: config.enabled,
    selected: 0,
    evaluated: 0,
    errors: 0,
    journeyMissing: 0,
    intentsProposed: 0,
    intentsCreated: 0,
    intentsReactivated: 0,
    intentsDeduplicated: 0,
    intentsSuperseded: 0,
    activeClaimsPreserved: 0,
    compareAndSetLost: 0,
    coordinationIntentWrites: 0,
    operationalIssueWrites: 0,
    ownerEngineExecutions: 0,
    actionCounts: {},
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
        "GUEST_JOURNEY_COORDINATION_INTENTS_CYCLE",
      metrics,
    });
    return metrics;
  }

  const now = requireValidNow(
    options.now ?? new Date()
  );
  const materialize =
    options.materialize ??
    materializeGuestJourneyCoordinationIntents;
  const candidates = await selectCandidates(
    prisma,
    {
      config,
      now,
      cursor:
        String(options.cursor ?? "").trim() ||
        null,
    }
  );

  metrics.selected = candidates.length;
  metrics.nextCursor =
    candidates.length === config.batchSize
      ? candidates.at(-1)?.id ?? null
      : null;

  for (const candidate of candidates) {
    try {
      const result = await materialize(
        prisma,
        candidate.id,
        {
          now,
          scope: {
            organizationId:
              candidate.property
                .organizationId,
            propertyId:
              candidate.propertyId,
          },
        }
      );

      metrics.evaluated += 1;
      metrics.intentsProposed +=
        result.proposed;
      metrics.intentsCreated +=
        result.created;
      metrics.intentsReactivated +=
        result.reactivated;
      metrics.intentsDeduplicated +=
        result.deduplicated;
      metrics.intentsSuperseded +=
        result.superseded;
      metrics.activeClaimsPreserved +=
        result.activeClaimsPreserved;
      metrics.compareAndSetLost +=
        result.compareAndSetLost;
      metrics.coordinationIntentWrites +=
        result.coordinationIntentWrites;

      for (const action of result.actions) {
        incrementAction(metrics, action);
      }
    } catch (error) {
      metrics.errors += 1;
      const code = toErrorCode(error);
      metrics.errorCodeCounts[code] =
        (metrics.errorCodeCounts[code] ??
          0) + 1;
    }
  }

  metrics.durationMs =
    Date.now() - startedAtMs;
  options.logger?.({
    event:
      "GUEST_JOURNEY_COORDINATION_INTENTS_CYCLE",
    metrics,
  });

  return metrics;
}
