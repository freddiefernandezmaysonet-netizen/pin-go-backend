import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { Provider } from "./airbnb-post-auth-autopilot.owner.js";

export type AirbnbMissedActivationRecoveryTarget = {
  organizationId: string;
  propertyId: string;
  connectionId: string;
  channelId: string;
  externalPropertyId: string;
  externalGroupId: string;
  ratePlanId: string;
  listingId: string;
};

export class AirbnbMissedActivationRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbMissedActivationRecoveryError";
  }
}

function recoveryDecisionId(target: AirbnbMissedActivationRecoveryTarget) {
  return `airbnb-missed-activation-recovery:${createHash("sha256")
    .update(
      [
        target.connectionId,
        target.channelId,
        target.ratePlanId,
        target.listingId,
      ].join(":")
    )
    .digest("hex")}`;
}

export async function recoverMissedAirbnbActivation(args: {
  prisma: PrismaClient;
  provider: Provider;
  target: AirbnbMissedActivationRecoveryTarget;
  observedAt?: Date;
}) {
  const observedAt = args.observedAt ?? new Date();
  if (!Number.isFinite(observedAt.getTime())) {
    throw new AirbnbMissedActivationRecoveryError(
      "AIRBNB_MISSED_ACTIVATION_OBSERVED_AT_INVALID"
    );
  }

  const channel = await args.provider.getChannel(args.target.channelId);
  const mappings = channel.mappings.filter(
    (mapping) => mapping.ratePlanId === args.target.ratePlanId
  );
  if (
    channel.id !== args.target.channelId ||
    channel.isActive !== true ||
    channel.groupId !== args.target.externalGroupId ||
    channel.propertyIds.length !== 1 ||
    channel.propertyIds[0] !== args.target.externalPropertyId ||
    mappings.length !== 1 ||
    mappings[0]?.listingId !== args.target.listingId
  ) {
    throw new AirbnbMissedActivationRecoveryError(
      "AIRBNB_MISSED_ACTIVATION_PROVIDER_EVIDENCE_INVALID"
    );
  }

  const decisionId = recoveryDecisionId(args.target);
  const existing = await args.prisma.apmsAuditEntry.findUnique({
    where: { decisionId },
    select: { id: true },
  });
  if (existing) {
    return { recovered: false as const, reason: "ALREADY_RECOVERED" as const };
  }

  await args.prisma.$transaction(
    async (tx) => {
      const connection = await tx.otaChannelConnection.findFirst({
        where: {
          id: args.target.connectionId,
          organizationId: args.target.organizationId,
          propertyId: args.target.propertyId,
          provider: "AIRBNB",
        },
        include: {
          distributionProperty: { include: { group: true } },
        },
      });
      const dp = connection?.distributionProperty;
      const group = dp?.group;
      if (
        !connection ||
        !dp ||
        !group ||
        connection.externalConnectionId !== args.target.channelId ||
        connection.status !== "NOT_CONNECTED" ||
        connection.readinessRevision !== 0 ||
        connection.lastLifecycleOccurredAt !== null ||
        connection.lastLifecycleOccurredAtMicros !== null ||
        connection.lastLifecycleEventType !== null ||
        connection.lastLifecycleEventPrecedence !== null ||
        connection.channelAuthorizationVerifiedAt !== null ||
        connection.lastChannelActivatedAt !== null ||
        dp.platform !== "CHANNEX" ||
        dp.provisioningStatus !== "READY" ||
        dp.externalPropertyId !== args.target.externalPropertyId ||
        dp.externalPrimaryRatePlanId !== args.target.ratePlanId ||
        group.platform !== "CHANNEX" ||
        group.provisioningStatus !== "READY" ||
        group.externalGroupId !== args.target.externalGroupId
      ) {
        throw new AirbnbMissedActivationRecoveryError(
          "AIRBNB_MISSED_ACTIVATION_LOCAL_STATE_CHANGED"
        );
      }

      const occurredAtMicros = BigInt(observedAt.getTime()) * 1000n;
      const updated = await tx.otaChannelConnection.updateMany({
        where: {
          id: connection.id,
          organizationId: connection.organizationId,
          propertyId: connection.propertyId,
          provider: "AIRBNB",
          status: "NOT_CONNECTED",
          externalConnectionId: args.target.channelId,
          readinessRevision: 0,
          lastLifecycleOccurredAt: null,
          lastLifecycleOccurredAtMicros: null,
          lastLifecycleEventType: null,
          lastLifecycleEventPrecedence: null,
          channelAuthorizationVerifiedAt: null,
          lastChannelActivatedAt: null,
          updatedAt: connection.updatedAt,
        },
        data: {
          externalChannelCode: "ABB",
          externalListingId: args.target.listingId,
          authorizationReadiness: "IN_PROGRESS",
          mappingReadiness: "IN_PROGRESS",
          distributionReadiness: "IN_PROGRESS",
          paymentReadiness: "NOT_STARTED",
          taxReadiness: "NOT_STARTED",
          contentReadiness: "NOT_STARTED",
          activationRequestedAt: null,
          activatedAt: null,
          lastFullSyncConfirmedAt: null,
          lastLifecycleOccurredAt: observedAt,
          lastLifecycleOccurredAtMicros: occurredAtMicros,
          lastLifecycleEventType: "activate_channel",
          lastLifecycleEventPrecedence: 30,
          channelAuthorizationVerifiedAt: observedAt,
          lastChannelActivatedAt: observedAt,
          lastErrorCode: null,
          lastErrorSummary: null,
          readinessRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new AirbnbMissedActivationRecoveryError(
          "AIRBNB_MISSED_ACTIVATION_RECOVERY_CONFLICT"
        );
      }

      await tx.apmsAuditEntry.create({
        data: {
          organizationId: args.target.organizationId,
          propertyId: args.target.propertyId,
          entityType: "DISTRIBUTION",
          entityId: args.target.connectionId,
          engine: "OTA_DISTRIBUTION_RECOVERY",
          eventType: "MISSED_ACTIVATION_RECOVERED",
          status: "SUCCESS",
          severity: "WARNING",
          decisionId,
          summary:
            "Recovered missed Airbnb activation watermark from exact provider observation",
          reason: "WEBHOOK_MISSING_AT_ACTIVATION_TIME",
          metadata: {
            provider: "AIRBNB",
            evidenceSource: "CHANNEX_PROVIDER_READ_AFTER_CONFIRMED_ACTIVATION",
            syntheticWebhook: false,
            channelId: args.target.channelId,
            externalPropertyId: args.target.externalPropertyId,
            externalGroupId: args.target.externalGroupId,
            ratePlanId: args.target.ratePlanId,
            listingId: args.target.listingId,
            providerActive: true,
            observedAt: observedAt.toISOString(),
            previousReadinessRevision: 0,
            canonicalReadinessRevision: 1,
          },
          startedAt: observedAt,
          completedAt: observedAt,
          durationMs: 0,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );

  return {
    recovered: true as const,
    observedAt,
    decisionId,
  };
}
