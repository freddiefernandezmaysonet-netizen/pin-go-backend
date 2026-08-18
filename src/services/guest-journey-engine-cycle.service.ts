import {
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  reconcileGuestJourney,
} from "./guest-journey-reconciler.service";
import type {
  GuestJourneyInternalReconcileAction,
  GuestJourneyInternalReconcileActionCode,
} from "./guest-journey-reconciler.service";
import type {
  GuestJourneyInternalReconcileConfig,
} from "./guest-journey-internal-reconcile.config";

export type GuestJourneyEngineCycleMetrics = {
  enabled: boolean;
  selected: number;
  reconciled: number;
  errors: number;
  reconstructed: number;
  transitions: number;
  timestampsRepaired: number;
  compareAndSetLost: number;
  aheadPreserved: number;
  terminalContradictionsPreserved: number;
  noAction: number;
  proposedCoordinationIntentsObserved: number;
  coordinationIntentWrites: 0;
  operationalIssueWrites: 0;
  ownerEngineExecutions: 0;
  actionCounts: Partial<
    Record<
      GuestJourneyInternalReconcileActionCode,
      number
    >
  >;
  errorCodeCounts: Record<string, number>;
  durationMs: number;
  nextCursor: string | null;
};

export type GuestJourneyEngineCycleLog = {
  event:
    "GUEST_JOURNEY_INTERNAL_RECONCILE_CYCLE";
  metrics: GuestJourneyEngineCycleMetrics;
};

type GuestJourneyCandidate = {
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
      "GUEST_JOURNEY_INTERNAL_RECONCILE_NOW_INVALID"
    );
  }

  return now;
}

function requireSafeConfig(
  config:
    GuestJourneyInternalReconcileConfig
): void {
  if (
    !Number.isInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > 50
  ) {
    throw new Error(
      "GUEST_JOURNEY_INTERNAL_RECONCILE_BATCH_SIZE_INVALID"
    );
  }

  if (
    !Number.isInteger(config.horizonDays) ||
    config.horizonDays < 1 ||
    config.horizonDays > 365
  ) {
    throw new Error(
      "GUEST_JOURNEY_INTERNAL_RECONCILE_HORIZON_DAYS_INVALID"
    );
  }

  if (
    !Number.isInteger(config.lookbackDays) ||
    config.lookbackDays < 1 ||
    config.lookbackDays > 30
  ) {
    throw new Error(
      "GUEST_JOURNEY_INTERNAL_RECONCILE_LOOKBACK_DAYS_INVALID"
    );
  }

  if (
    config.enabled &&
    config.organizationIds.length === 0 &&
    config.propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_INTERNAL_RECONCILE_SCOPE_REQUIRED"
    );
  }
}

function buildCandidateWhere(input: {
  config:
    GuestJourneyInternalReconcileConfig;
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
      GuestJourneyInternalReconcileConfig;
    now: Date;
    cursor: string | null;
  }
): Promise<GuestJourneyCandidate[]> {
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
    GuestJourneyEngineCycleMetrics,
  action:
    GuestJourneyInternalReconcileAction
): void {
  metrics.actionCounts[action.code] =
    (metrics.actionCounts[action.code] ?? 0) +
    1;

  switch (action.code) {
    case "CREATE_JOURNEY_FROM_EVIDENCE":
      metrics.reconstructed += 1;
      return;
    case "ADVANCE_CANONICAL_TRANSITION":
      metrics.transitions +=
        typeof action.metadata
          ?.transitionCount === "number"
          ? action.metadata.transitionCount
          : 1;
      return;
    case "REPAIR_CANONICAL_TIMESTAMP":
      metrics.timestampsRepaired += 1;
      return;
    case "COMPARE_AND_SET_LOST":
      metrics.compareAndSetLost += 1;
      return;
    case "PRESERVE_AHEAD_STATE":
      metrics.aheadPreserved += 1;
      return;
    case "PRESERVE_TERMINAL_STATE":
      metrics
        .terminalContradictionsPreserved += 1;
      return;
    case "NO_ACTION":
      metrics.noAction += 1;
      return;
  }
}

export async function runGuestJourneyEngineCycle(
  prisma: PrismaClient,
  config:
    GuestJourneyInternalReconcileConfig,
  options: {
    now?: Date;
    cursor?: string | null;
    reconcile?:
      typeof reconcileGuestJourney;
    logger?: (
      entry: GuestJourneyEngineCycleLog
    ) => void;
  } = {}
): Promise<GuestJourneyEngineCycleMetrics> {
  const startedAtMs = Date.now();
  const metrics:
    GuestJourneyEngineCycleMetrics = {
    enabled: config.enabled,
    selected: 0,
    reconciled: 0,
    errors: 0,
    reconstructed: 0,
    transitions: 0,
    timestampsRepaired: 0,
    compareAndSetLost: 0,
    aheadPreserved: 0,
    terminalContradictionsPreserved: 0,
    noAction: 0,
    proposedCoordinationIntentsObserved:
      0,
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
        "GUEST_JOURNEY_INTERNAL_RECONCILE_CYCLE",
      metrics,
    });
    return metrics;
  }

  const now = requireValidNow(
    options.now ?? new Date()
  );
  const reconcile =
    options.reconcile ??
    reconcileGuestJourney;
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
      const result =
        await reconcile(
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

      metrics.reconciled += 1;
      metrics
        .proposedCoordinationIntentsObserved +=
        result
          .proposedCoordinationIntentCount;

      for (const action of result.actions) {
        incrementAction(
          metrics,
          action
        );
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
      "GUEST_JOURNEY_INTERNAL_RECONCILE_CYCLE",
    metrics,
  });

  return metrics;
}
