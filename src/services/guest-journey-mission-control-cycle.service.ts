import {
  GuestJourneyCoordinationIntentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import type {
  GuestJourneyOwnerRuntimeConfig,
} from "./guest-journey-owner-runtime.config";
import type {
  GuestJourneyMissionControlConfig,
} from "./guest-journey-mission-control.config";
import {
  syncGuestJourneyOwnerIntentMissionControl,
} from "./guest-journey-mission-control-bridge.service";
import type {
  GuestJourneyMissionControlIntent,
  GuestJourneyMissionControlSyncResult,
} from "./guest-journey-mission-control-bridge.service";

export type GuestJourneyMissionControlCycleMetrics = {
  enabled: boolean;
  selected: number;
  projected: number;
  created: number;
  updated: number;
  reopened: number;
  unchanged: number;
  escalated: number;
  resolved: number;
  errors: number;
  operationalIssueWrites: number;
  ownerEngineExecutions: 0;
  credentialWrites: 0;
  messageSends: 0;
  paymentCalls: 0;
  externalSideEffects: 0;
  errorCodeCounts: Record<string, number>;
  durationMs: number;
  nextCursor: string | null;
};

export type GuestJourneyMissionControlCycleLog = {
  event:
    "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_CYCLE";
  metrics:
    GuestJourneyMissionControlCycleMetrics;
};

type CycleDependencies = {
  sync:
    typeof syncGuestJourneyOwnerIntentMissionControl;
};

const DEFAULT_DEPENDENCIES:
  CycleDependencies = {
    sync:
      syncGuestJourneyOwnerIntentMissionControl,
  };

const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE_STATUSES = [
  GuestJourneyCoordinationIntentStatus.PENDING,
  GuestJourneyCoordinationIntentStatus.CLAIMED,
  GuestJourneyCoordinationIntentStatus.WAITING_FOR_EVIDENCE,
  GuestJourneyCoordinationIntentStatus.RETRYABLE,
] as const;

function requireSafeConfig(
  config:
    GuestJourneyMissionControlConfig
): void {
  if (
    !Number.isSafeInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > 100
  ) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_BATCH_SIZE_INVALID"
    );
  }

  if (
    !Number.isSafeInteger(config.lookbackDays) ||
    config.lookbackDays < 1 ||
    config.lookbackDays > 90
  ) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_LOOKBACK_DAYS_INVALID"
    );
  }

  if (
    config.enabled &&
    config.organizationIds.length === 0 &&
    config.propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_SCOPE_REQUIRED"
    );
  }
}

function buildScopeFilters(
  config:
    GuestJourneyMissionControlConfig
): Prisma.GuestJourneyCoordinationIntentWhereInput[] {
  const filters:
    Prisma.GuestJourneyCoordinationIntentWhereInput[] = [];

  if (config.organizationIds.length > 0) {
    filters.push({
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
    });
  }

  if (config.propertyIds.length > 0) {
    filters.push({
      reservation: {
        is: {
          propertyId: {
            in: config.propertyIds,
          },
        },
      },
    });
  }

  return filters;
}

async function selectCandidates(
  prisma: PrismaClient,
  input: {
    config:
      GuestJourneyMissionControlConfig;
    now: Date;
    cursor: string | null;
  }
): Promise<
  GuestJourneyMissionControlIntent[]
> {
  const recentTerminalFrom = new Date(
    input.now.getTime() -
      input.config.lookbackDays * DAY_MS
  );

  return prisma
    .guestJourneyCoordinationIntent
    .findMany({
      where: {
        targetEngine: "ACCESS",
        intentType:
          "REQUEST_ACCESS_EVALUATION",
        AND: [
          {
            OR: buildScopeFilters(
              input.config
            ),
          },
          {
            OR: [
              {
                status: {
                  in: [...ACTIVE_STATUSES],
                },
              },
              {
                status: {
                  in: [
                    GuestJourneyCoordinationIntentStatus.SUCCEEDED,
                    GuestJourneyCoordinationIntentStatus.EXHAUSTED,
                    GuestJourneyCoordinationIntentStatus.SUPERSEDED,
                  ],
                },
                updatedAt: {
                  gte: recentTerminalFrom,
                },
              },
            ],
          },
        ],
      },
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
        reservationId: true,
        status: true,
        targetEngine: true,
        intentType: true,
        reasonCode: true,
        expectedOutcomeCode: true,
        claimCount: true,
        nextActionAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        succeededAt: true,
        exhaustedAt: true,
        supersededAt: true,
        reservation: {
          select: {
            reservationNumber: true,
            guestName: true,
            propertyId: true,
            property: {
              select: {
                organizationId: true,
              },
            },
          },
        },
        attempts: {
          orderBy: {
            attemptNumber: "desc",
          },
          take: 1,
          select: {
            outcome: true,
            errorCode: true,
            completedAt: true,
          },
        },
      },
    });
}

function isOwnerRuntimeEnabledForIntent(input: {
  intent:
    GuestJourneyMissionControlIntent;
  ownerRuntimeConfig:
    GuestJourneyOwnerRuntimeConfig;
}): boolean {
  if (!input.ownerRuntimeConfig.enabled) {
    return false;
  }

  return (
    input.ownerRuntimeConfig
      .organizationIds.includes(
        input.intent.reservation
          .property.organizationId
      ) ||
    input.ownerRuntimeConfig
      .propertyIds.includes(
        input.intent.reservation
          .propertyId
      )
  );
}

function toErrorCode(
  error: unknown
): string {
  const structuredCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown })
      .code === "string"
      ? (error as { code: string })
          .code
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

function countSyncAction(
  metrics:
    GuestJourneyMissionControlCycleMetrics,
  action:
    GuestJourneyMissionControlSyncResult["lifecycle"]
): void {
  if (action === "CREATED") {
    metrics.created += 1;
  } else if (action === "UPDATED") {
    metrics.updated += 1;
  } else if (action === "REOPENED") {
    metrics.reopened += 1;
  } else if (action === "UNCHANGED") {
    metrics.unchanged += 1;
  }
}

export async function runGuestJourneyMissionControlCycle(
  prisma: PrismaClient,
  config:
    GuestJourneyMissionControlConfig,
  ownerRuntimeConfig:
    GuestJourneyOwnerRuntimeConfig,
  options: {
    now?: Date;
    cursor?: string | null;
    logger?: (
      entry:
        GuestJourneyMissionControlCycleLog
    ) => void;
    dependencies?: Partial<
      CycleDependencies
    >;
  } = {}
): Promise<GuestJourneyMissionControlCycleMetrics> {
  const startedAtMs = Date.now();
  const metrics:
    GuestJourneyMissionControlCycleMetrics = {
    enabled: config.enabled,
    selected: 0,
    projected: 0,
    created: 0,
    updated: 0,
    reopened: 0,
    unchanged: 0,
    escalated: 0,
    resolved: 0,
    errors: 0,
    operationalIssueWrites: 0,
    ownerEngineExecutions: 0,
    credentialWrites: 0,
    messageSends: 0,
    paymentCalls: 0,
    externalSideEffects: 0,
    errorCodeCounts: {},
    durationMs: 0,
    nextCursor: options.cursor ?? null,
  };

  requireSafeConfig(config);

  if (!config.enabled) {
    metrics.nextCursor = null;
    metrics.durationMs =
      Date.now() - startedAtMs;
    options.logger?.({
      event:
        "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_CYCLE",
      metrics,
    });
    return metrics;
  }

  const now = options.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error(
      "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_NOW_INVALID"
    );
  }

  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  const candidates =
    await selectCandidates(prisma, {
      config,
      now,
      cursor: options.cursor ?? null,
    });

  metrics.selected = candidates.length;

  for (const intent of candidates) {
    try {
      const result =
        await dependencies.sync(
          prisma,
          intent,
          {
            ownerRuntimeEnabled:
              isOwnerRuntimeEnabledForIntent({
                intent,
                ownerRuntimeConfig,
              }),
            expectedScope: {
              organizationId:
                intent.reservation
                  .property.organizationId,
              propertyId:
                intent.reservation
                  .propertyId,
            },
          }
        );

      metrics.projected += 1;
      metrics.operationalIssueWrites +=
        result.operationalIssueWrites;
      countSyncAction(
        metrics,
        result.lifecycle
      );
      countSyncAction(
        metrics,
        result.escalation
      );

      if (
        intent.status ===
        GuestJourneyCoordinationIntentStatus.EXHAUSTED
      ) {
        metrics.escalated += 1;
      }

      if (
        intent.status ===
          GuestJourneyCoordinationIntentStatus.SUCCEEDED ||
        intent.status ===
          GuestJourneyCoordinationIntentStatus.SUPERSEDED
      ) {
        metrics.resolved += 1;
      }
    } catch (error) {
      metrics.errors += 1;
      const code = toErrorCode(error);
      metrics.errorCodeCounts[code] =
        (metrics.errorCodeCounts[code] ??
          0) + 1;
    }
  }

  metrics.nextCursor =
    candidates.length ===
      config.batchSize
      ? candidates.at(-1)?.id ?? null
      : null;
  metrics.durationMs =
    Date.now() - startedAtMs;

  options.logger?.({
    event:
      "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_CYCLE",
    metrics,
  });

  return metrics;
}
