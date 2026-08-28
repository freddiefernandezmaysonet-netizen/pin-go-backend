import {
  assertGuestJourneyTenantPropertyScope,
  buildGuestJourneyCoordinationIntentScopeWhere,
} from "./guest-journey-tenant-property-scope.policy";

import { randomBytes } from "node:crypto";

import {
  GuestJourneyCoordinationIntentStatus,
  PrismaClient,
} from "@prisma/client";

import { executeGuestJourneyCommunicationDeliveryAdapter } from "./guest-journey-communications-delivery-adapter.service";
import { syncGuestJourneyCommunicationMissionControl } from "./guest-journey-communications-mission-control.service";
import type { GuestJourneyCommunicationsOwnerConfig } from "./guest-journey-communications-owner.config";
import {
  claimGuestJourneyCommunicationIntent,
  completeGuestJourneyCommunicationIntent,
  normalizeCommunicationsOwnerError,
} from "./guest-journey-communications-owner-runtime.service";

export type CommunicationsOwnerCycleMetrics = {
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
  claim: typeof claimGuestJourneyCommunicationIntent;
  execute: typeof executeGuestJourneyCommunicationDeliveryAdapter;
  complete: typeof completeGuestJourneyCommunicationIntent;
  syncMissionControl: typeof syncGuestJourneyCommunicationMissionControl;
  leaseTokenFactory: () => string;
  clock: () => Date;
};

const DEFAULT_DEPENDENCIES: CycleDependencies = {
  claim: claimGuestJourneyCommunicationIntent,
  execute: executeGuestJourneyCommunicationDeliveryAdapter,
  complete: completeGuestJourneyCommunicationIntent,
  syncMissionControl: syncGuestJourneyCommunicationMissionControl,
  leaseTokenFactory: () => randomBytes(32).toString("base64url"),
  clock: () => new Date(),
};

function validateConfig(config: GuestJourneyCommunicationsOwnerConfig): void {
  assertGuestJourneyTenantPropertyScope({
    enabled: config.enabled,
    scope: config,
    errorCode: "GUEST_JOURNEY_COMMUNICATIONS_SCOPE_REQUIRED",
  });
}

async function selectCandidates(
  prisma: PrismaClient,
  config: GuestJourneyCommunicationsOwnerConfig,
  now: Date
): Promise<Array<{ id: string; reservation: { propertyId: string; property: { organizationId: string } } }>> {

  return prisma.guestJourneyCoordinationIntent.findMany({
    where: {
      targetEngine: "COMMUNICATIONS",
      intentType: { in: ["REQUEST_COMMUNICATION", "REQUEST_COMMUNICATION_RETRY"] },
      AND: [
        buildGuestJourneyCoordinationIntentScopeWhere(
          config
        ),
        { OR: [
          {
            status: { in: [
              GuestJourneyCoordinationIntentStatus.PENDING,
              GuestJourneyCoordinationIntentStatus.RETRYABLE,
            ] },
            OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }],
          },
          {
            status: GuestJourneyCoordinationIntentStatus.CLAIMED,
            leaseExpiresAt: { lte: now },
          },
        ] },
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

export async function runGuestJourneyCommunicationsOwnerCycle(
  prisma: PrismaClient,
  config: GuestJourneyCommunicationsOwnerConfig,
  options: {
    now?: Date;
    logger?: (entry: { event: "GUEST_JOURNEY_COMMUNICATIONS_OWNER_CYCLE"; metrics: CommunicationsOwnerCycleMetrics }) => void;
    dependencies?: Partial<CycleDependencies>;
  } = {}
): Promise<CommunicationsOwnerCycleMetrics> {
  const startedAt = Date.now();
  const metrics: CommunicationsOwnerCycleMetrics = {
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
    options.logger?.({ event: "GUEST_JOURNEY_COMMUNICATIONS_OWNER_CYCLE", metrics });
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
        const execution = await dependencies.execute(
          prisma,
          claimed.claim,
          {
            now: dependencies.clock(),
            providerTimeoutMs: config.providerTimeoutMs,
          }
        );
        metrics.executed += 1;
        metrics.providerCalls += execution.providerCalls;
        completion = execution.completion;
      } catch (error) {
        const normalized = normalizeCommunicationsOwnerError(error);
        completion = {
          kind: "RETRYABLE" as const,
          outcomeEvidenceFingerprint: claimed.claim.inputEvidenceFingerprint,
          errorCode: normalized.code,
          errorDetail: normalized.detail,
          messageLogId: String(claimed.claim.payload.messageLogId ?? "") || null,
          communicationType: String(claimed.claim.payload.communicationType ?? "") || null,
          channel: String(claimed.claim.payload.channel ?? "") || null,
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
      const normalized = normalizeCommunicationsOwnerError(error);
      metrics.errorCodeCounts[normalized.code] =
        (metrics.errorCodeCounts[normalized.code] ?? 0) + 1;
    }
  }

  metrics.durationMs = Date.now() - startedAt;
  options.logger?.({ event: "GUEST_JOURNEY_COMMUNICATIONS_OWNER_CYCLE", metrics });
  return metrics;
}
