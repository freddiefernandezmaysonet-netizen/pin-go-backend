import { randomBytes } from "node:crypto";

import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import { executeGuestJourneyAccessOwnerAdapter } from "./guest-journey-access-owner-adapter.service";
import type { GuestJourneyAccessOwnerConfig } from "./guest-journey-access-owner.config";
import { syncGuestJourneyAccessOwnerMissionControl } from "./guest-journey-access-owner-mission-control.service";
import {
  claimGuestJourneyAccessIntent,
  completeGuestJourneyAccessIntent,
  normalizeAccessOwnerError,
} from "./guest-journey-access-owner-runtime.service";

export type AccessOwnerCycleMetrics = {
  enabled: boolean;
  selected: number;
  claimAttempts: number;
  claimed: number;
  recoveredStaleLeases: number;
  claimRaces: number;
  liveLeases: number;
  executed: number;
  providerCalls: number;
  succeeded: number;
  waitingForEvidence: number;
  retryable: number;
  exhausted: number;
  errors: number;
  operationalIssueWrites: number;
  errorCodeCounts: Record<string, number>;
  durationMs: number;
};

type CycleDependencies = {
  claim: typeof claimGuestJourneyAccessIntent;
  execute: typeof executeGuestJourneyAccessOwnerAdapter;
  complete: typeof completeGuestJourneyAccessIntent;
  syncMissionControl: typeof syncGuestJourneyAccessOwnerMissionControl;
  leaseTokenFactory: () => string;
  clock: () => Date;
};

const DEFAULT_DEPENDENCIES: CycleDependencies = {
  claim: claimGuestJourneyAccessIntent,
  execute: executeGuestJourneyAccessOwnerAdapter,
  complete: completeGuestJourneyAccessIntent,
  syncMissionControl: syncGuestJourneyAccessOwnerMissionControl,
  leaseTokenFactory: () => randomBytes(32).toString("base64url"),
  clock: () => new Date(),
};

function validateConfig(config: GuestJourneyAccessOwnerConfig): void {
  if (config.enabled && config.organizationIds.length === 0 && config.propertyIds.length === 0) {
    throw new Error("GUEST_JOURNEY_ACCESS_OWNER_SCOPE_REQUIRED");
  }
}

async function selectCandidates(
  prisma: PrismaClient,
  config: GuestJourneyAccessOwnerConfig,
  now: Date
): Promise<Array<{
  id: string;
  reservation: { propertyId: string; property: { organizationId: string } };
}>> {
  const scopeFilters = [
    ...(config.organizationIds.length > 0 ? [{
      reservation: { is: { property: { is: { organizationId: { in: config.organizationIds } } } } },
    }] : []),
    ...(config.propertyIds.length > 0 ? [{
      reservation: { is: { propertyId: { in: config.propertyIds } } },
    }] : []),
  ];
  const provisionThrough = new Date(now.getTime() + config.provisionLeadMs);
  return prisma.guestJourneyCoordinationIntent.findMany({
    where: {
      targetEngine: "ACCESS",
      intentType: {
        in: [
          "REQUEST_ACCESS_PROVISIONING",
          "REQUEST_ACCESS_REVOCATION_CHECK",
        ],
      },
      AND: [
        { OR: scopeFilters },
        {
          OR: [
            {
              intentType: "REQUEST_ACCESS_PROVISIONING",
              reservation: {
                is: {
                  status: ReservationStatus.ACTIVE,
                  checkIn: { lte: provisionThrough },
                  checkOut: { gt: now },
                },
              },
            },
            {
              intentType: "REQUEST_ACCESS_REVOCATION_CHECK",
              reservation: {
                is: {
                  OR: [
                    { status: ReservationStatus.CANCELLED },
                    { checkOut: { lte: now } },
                  ],
                },
              },
            },
          ],
        },
        {
          OR: [
            {
              status: {
                in: [
                  GuestJourneyCoordinationIntentStatus.PENDING,
                  GuestJourneyCoordinationIntentStatus.RETRYABLE,
                ],
              },
              OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }],
            },
            {
              status: GuestJourneyCoordinationIntentStatus.CLAIMED,
              leaseExpiresAt: { lte: now },
            },
          ],
        },
      ],
    },
    orderBy: [{ nextActionAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: config.batchSize,
    select: {
      id: true,
      reservation: {
        select: {
          propertyId: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });
}

export async function runGuestJourneyAccessOwnerCycle(
  prisma: PrismaClient,
  config: GuestJourneyAccessOwnerConfig,
  options: {
    now?: Date;
    logger?: (entry: {
      event: "GUEST_JOURNEY_ACCESS_OWNER_CYCLE";
      metrics: AccessOwnerCycleMetrics;
    }) => void;
    dependencies?: Partial<CycleDependencies>;
  } = {}
): Promise<AccessOwnerCycleMetrics> {
  const startedAt = Date.now();
  const metrics: AccessOwnerCycleMetrics = {
    enabled: config.enabled,
    selected: 0,
    claimAttempts: 0,
    claimed: 0,
    recoveredStaleLeases: 0,
    claimRaces: 0,
    liveLeases: 0,
    executed: 0,
    providerCalls: 0,
    succeeded: 0,
    waitingForEvidence: 0,
    retryable: 0,
    exhausted: 0,
    errors: 0,
    operationalIssueWrites: 0,
    errorCodeCounts: {},
    durationMs: 0,
  };
  validateConfig(config);
  if (!config.enabled) {
    metrics.durationMs = Date.now() - startedAt;
    options.logger?.({ event: "GUEST_JOURNEY_ACCESS_OWNER_CYCLE", metrics });
    return metrics;
  }

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const now = options.now ?? dependencies.clock();
  const candidates = await selectCandidates(prisma, config, now);
  metrics.selected = candidates.length;

  for (const candidate of candidates) {
    metrics.claimAttempts += 1;
    try {
      const claimed = await dependencies.claim(prisma, {
        intentId: candidate.id,
        leaseToken: dependencies.leaseTokenFactory(),
        scope: {
          organizationIds: config.organizationIds,
          propertyIds: config.propertyIds,
        },
        leaseMs: config.leaseMs,
        maxClaims: config.maxClaims,
        now,
      });
      if (!claimed.claimed) {
        if (claimed.reason === "CLAIM_RACE") metrics.claimRaces += 1;
        if (claimed.reason === "LIVE_LEASE") metrics.liveLeases += 1;
        if (claimed.reason === "EXHAUSTED") {
          metrics.exhausted += 1;
          const projection = await dependencies.syncMissionControl(
            prisma,
            candidate.id,
            {
              organizationId: candidate.reservation.property.organizationId,
              propertyId: candidate.reservation.propertyId,
            }
          );
          metrics.operationalIssueWrites += projection.operationalIssueWrites;
        }
        continue;
      }

      metrics.claimed += 1;
      if (claimed.recoveredStaleLease) metrics.recoveredStaleLeases += 1;

      let completion;
      try {
        const execution = await dependencies.execute(prisma, claimed.claim, {
          now: dependencies.clock(),
          provisionLeadMs: config.provisionLeadMs,
          providerTimeoutMs: config.providerTimeoutMs,
        });
        metrics.executed += 1;
        metrics.providerCalls += execution.providerCalls;
        completion = execution.completion;
      } catch (error) {
        const normalized = normalizeAccessOwnerError(error);
        completion = {
          kind: "RETRYABLE" as const,
          outcomeEvidenceFingerprint: claimed.claim.inputEvidenceFingerprint,
          errorCode: normalized.code,
          errorDetail: normalized.detail,
          accessGrantIds: [],
        };
      }

      const completed = await dependencies.complete(prisma, {
        claim: claimed.claim,
        completion,
        maxClaims: config.maxClaims,
        retryBaseMs: config.retryBaseMs,
        now: dependencies.clock(),
      });
      if (completed.status === "SUCCEEDED") metrics.succeeded += 1;
      else if (completed.status === "WAITING_FOR_EVIDENCE") metrics.waitingForEvidence += 1;
      else if (completed.status === "RETRYABLE") metrics.retryable += 1;
      else metrics.exhausted += 1;

      const projection = await dependencies.syncMissionControl(
        prisma,
        claimed.claim.intentId,
        {
          organizationId: claimed.claim.organizationId,
          propertyId: claimed.claim.propertyId,
        }
      );
      metrics.operationalIssueWrites += projection.operationalIssueWrites;
    } catch (error) {
      metrics.errors += 1;
      const normalized = normalizeAccessOwnerError(error);
      metrics.errorCodeCounts[normalized.code] =
        (metrics.errorCodeCounts[normalized.code] ?? 0) + 1;
    }
  }

  metrics.durationMs = Date.now() - startedAt;
  options.logger?.({ event: "GUEST_JOURNEY_ACCESS_OWNER_CYCLE", metrics });
  return metrics;
}
