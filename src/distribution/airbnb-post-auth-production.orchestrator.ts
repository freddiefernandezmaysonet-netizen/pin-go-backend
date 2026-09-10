import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";

import { requireIanaTimezone } from "../lib/iana-timezone.js";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service.js";
import {
  createChannexReadonlyHttpTransport,
} from "./channex-readonly.http-transport.js";
import {
  reconcileCanonicalOtaReadiness,
  type CanonicalOtaReadinessClient,
} from "./channex-canonical-readiness.service.js";
import type {
  Provider,
  Reconciler,
} from "./airbnb-post-auth-autopilot.owner.js";

export const AIRBNB_POST_ACTIVATION_FULL_SYNC_TRIGGER =
  "AIRBNB_POST_ACTIVATION_AUTOPILOT" as const;

const SOURCE_ENTITY_TYPE = "OTA_CHANNEL_CONNECTION";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AirbnbPostActivationItem = {
  connectionId: string;
  outcome:
    | "QUEUED_FULL_SYNC"
    | "WAIT_FULL_SYNC"
    | "WAIT_CANONICAL"
    | "ACTIVE"
    | "ACTION_REQUIRED";
  reason: string;
  correlationId?: string;
};

export type AirbnbPostActivationCycleResult = {
  scanned: number;
  queued: number;
  reconciled: number;
  active: number;
  items: AirbnbPostActivationItem[];
};

export class AirbnbPostActivationOrchestratorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbPostActivationOrchestratorError";
  }
}

function text(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}

function uuid(value: unknown): string | null {
  const result = text(value);
  return result && UUID.test(result) ? result : null;
}

function validDate(value: unknown): Date | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return new Date(value);
}

function safeRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function correlationId(connectionId: string, activatedAt: Date): string {
  const digest = createHash("sha256")
    .update(`${connectionId}:${activatedAt.toISOString()}`)
    .digest("hex")
    .slice(0, 32);
  return `airbnb-post-activation:${digest}`;
}

function queueDecisionId(connectionId: string, activatedAt: Date): string {
  return `airbnb-post-activation-full-sync:${createHash("sha256")
    .update(`${connectionId}:${activatedAt.toISOString()}`)
    .digest("hex")}`;
}

function todayDateKey(now: Date, timezone: unknown): string {
  const zone = requireIanaTimezone(timezone);
  return formatInTimeZone(now, zone, "yyyy-MM-dd");
}

function adaptPrismaCanonicalReadinessClient(
  prisma: PrismaClient
): CanonicalOtaReadinessClient {
  return {
    distributionProperty: {
      async findFirst(query) {
        return (await prisma.distributionProperty.findFirst(query as any)) as any;
      },
    },
    otaChannelConnection: {
      async findFirst(query) {
        return (await prisma.otaChannelConnection.findFirst(query as any)) as any;
      },
    },
    channexAriPropertyState: {
      async findUnique(query) {
        return (await prisma.channexAriPropertyState.findUnique(query as any)) as any;
      },
    },
    pmsListing: {
      async findMany(query) {
        return (await prisma.pmsListing.findMany(query as any)) as any;
      },
    },
    distributionOutboxEvent: {
      async findMany(query) {
        return (await prisma.distributionOutboxEvent.findMany(query as any)) as any;
      },
    },
    apmsAuditEntry: {
      async findUnique(query) {
        return (await prisma.apmsAuditEntry.findUnique(query as any)) as any;
      },
    },
    async $transaction(work, options) {
      return prisma.$transaction(
        async (tx) =>
          work({
            distributionProperty: {
              async findFirst(query) {
                return (await tx.distributionProperty.findFirst(query as any)) as any;
              },
            },
            otaChannelConnection: {
              async findFirst(query) {
                return (await tx.otaChannelConnection.findFirst(query as any)) as any;
              },
              async updateMany(query) {
                return tx.otaChannelConnection.updateMany(query as any);
              },
            },
            channexAriPropertyState: {
              async findUnique(query) {
                return (await tx.channexAriPropertyState.findUnique(query as any)) as any;
              },
            },
            pmsListing: {
              async findMany(query) {
                return (await tx.pmsListing.findMany(query as any)) as any;
              },
            },
            distributionOutboxEvent: {
              async findMany(query) {
                return (await tx.distributionOutboxEvent.findMany(query as any)) as any;
              },
            },
            apmsAuditEntry: {
              async findUnique(query) {
                return (await tx.apmsAuditEntry.findUnique(query as any)) as any;
              },
              async create(query) {
                return tx.apmsAuditEntry.create(query as any);
              },
            },
          }),
        options as any
      );
    },
  };
}

export function createAirbnbPostAuthCanonicalReconciler(args: {
  prisma: PrismaClient;
  apiOrigin: string;
  apiKey: string;
  timeoutMs?: number;
}): Reconciler {
  const transport = createChannexReadonlyHttpTransport({
    apiOrigin: args.apiOrigin,
    apiKey: args.apiKey,
    timeoutMs: args.timeoutMs ?? 10_000,
  });
  const client = adaptPrismaCanonicalReadinessClient(args.prisma);

  return ({
    organizationId,
    propertyId,
    requestedByUserId,
    provider,
    requestKey,
  }) =>
    reconcileCanonicalOtaReadiness({
      client,
      transport,
      organizationId,
      propertyId,
      requestedByUserId,
      provider,
      requestKey,
    });
}

function validateCandidate(connection: any) {
  const dp = connection?.distributionProperty;
  const group = dp?.group;
  const property = dp?.property;
  const externalConnectionId = uuid(connection?.externalConnectionId);
  const externalPropertyId = uuid(dp?.externalPropertyId);
  const externalRatePlanId = uuid(dp?.externalPrimaryRatePlanId);
  const externalGroupId = uuid(group?.externalGroupId);
  const activatedAt = validDate(connection?.lastChannelActivatedAt);
  const readinessRevision = safeRevision(connection?.readinessRevision);

  if (
    !connection ||
    connection.provider !== "AIRBNB" ||
    !text(connection.organizationId) ||
    !text(connection.propertyId) ||
    !text(connection.id) ||
    !externalConnectionId ||
    !externalPropertyId ||
    !externalRatePlanId ||
    !externalGroupId ||
    !activatedAt ||
    readinessRevision === null ||
    dp?.platform !== "CHANNEX" ||
    dp?.provisioningStatus !== "READY" ||
    group?.platform !== "CHANNEX" ||
    group?.provisioningStatus !== "READY" ||
    property?.id !== connection.propertyId ||
    property?.organizationId !== connection.organizationId ||
    property?.status !== "ACTIVE" ||
    !text(property?.timezone)
  ) {
    return null;
  }

  return {
    connectionId: String(connection.id),
    organizationId: String(connection.organizationId),
    propertyId: String(connection.propertyId),
    externalConnectionId,
    externalPropertyId,
    externalRatePlanId,
    externalGroupId,
    activatedAt,
    readinessRevision,
    timezone: String(property.timezone),
  };
}

async function queueFullSyncOnce(args: {
  prisma: PrismaClient;
  connection: any;
  context: ReturnType<typeof validateCandidate> & {};
  now: Date;
}): Promise<{ queued: boolean; correlationId: string }> {
  const context = args.context;
  const cid = correlationId(context.connectionId, context.activatedAt);
  const decisionId = queueDecisionId(context.connectionId, context.activatedAt);

  const existing = await args.prisma.distributionOutboxEvent.findMany({
    where: {
      organizationId: context.organizationId,
      propertyId: context.propertyId,
      provider: "CHANNEX",
      correlationId: cid,
    },
    orderBy: { id: "asc" },
    take: 3,
    select: {
      id: true,
      messageKind: true,
      syncMode: true,
      scope: true,
      trigger: true,
      sourceEntityType: true,
      sourceEntityId: true,
      status: true,
      deliveryId: true,
      createdAt: true,
      delivery: { select: { status: true } },
    },
  });

  if (existing.length > 0) {
    if (
      existing.length !== 2 ||
      new Set(existing.map((row) => row.messageKind)).size !== 2 ||
      !existing.some((row) => row.messageKind === "AVAILABILITY") ||
      !existing.some((row) => row.messageKind === "RATES_RESTRICTIONS") ||
      existing.some(
        (row) =>
          row.syncMode !== "FULL" ||
          row.scope !== "FULL_HORIZON" ||
          row.trigger !== AIRBNB_POST_ACTIVATION_FULL_SYNC_TRIGGER ||
          row.sourceEntityType !== SOURCE_ENTITY_TYPE ||
          row.sourceEntityId !== context.connectionId
      )
    ) {
      throw new AirbnbPostActivationOrchestratorError(
        "AIRBNB_POST_ACTIVATION_FULL_SYNC_EVIDENCE_CONFLICT"
      );
    }
    return { queued: false, correlationId: cid };
  }

  const dateKey = todayDateKey(args.now, context.timezone);

  await args.prisma.$transaction(
    async (tx) => {
      const current = await tx.otaChannelConnection.findFirst({
        where: {
          id: context.connectionId,
          organizationId: context.organizationId,
          propertyId: context.propertyId,
          provider: "AIRBNB",
          externalConnectionId: context.externalConnectionId,
          readinessRevision: context.readinessRevision,
          lastChannelActivatedAt: context.activatedAt,
        },
        select: {
          id: true,
          status: true,
          readinessRevision: true,
          lastChannelActivatedAt: true,
        },
      });
      if (!current || current.status === "ACTIVE") {
        throw new AirbnbPostActivationOrchestratorError(
          "AIRBNB_POST_ACTIVATION_STATE_CHANGED"
        );
      }

      const priorAudit = await tx.apmsAuditEntry.findUnique({
        where: { decisionId },
        select: { id: true },
      });
      const priorRows = await tx.distributionOutboxEvent.findMany({
        where: {
          organizationId: context.organizationId,
          propertyId: context.propertyId,
          provider: "CHANNEX",
          correlationId: cid,
        },
        take: 1,
        select: { id: true },
      });
      if (priorAudit || priorRows.length) {
        throw new AirbnbPostActivationOrchestratorError(
          "AIRBNB_POST_ACTIVATION_QUEUE_RACE"
        );
      }

      await createChannexAriOutboxEvent(tx as any, {
        organizationId: context.organizationId,
        propertyId: context.propertyId,
        messageKind: "AVAILABILITY",
        syncMode: "FULL",
        trigger: AIRBNB_POST_ACTIVATION_FULL_SYNC_TRIGGER,
        sourceEntityType: SOURCE_ENTITY_TYPE,
        sourceEntityId: context.connectionId,
        correlationId: cid,
        todayDateKey: dateKey,
        now: args.now,
        coalesceMs: 0,
      });

      await createChannexAriOutboxEvent(tx as any, {
        organizationId: context.organizationId,
        propertyId: context.propertyId,
        messageKind: "RATES_RESTRICTIONS",
        syncMode: "FULL",
        trigger: AIRBNB_POST_ACTIVATION_FULL_SYNC_TRIGGER,
        sourceEntityType: SOURCE_ENTITY_TYPE,
        sourceEntityId: context.connectionId,
        correlationId: cid,
        todayDateKey: dateKey,
        now: args.now,
        coalesceMs: 0,
      });

      const state = await tx.channexAriPropertyState.findUnique({
        where: { propertyId: context.propertyId },
        select: { organizationId: true },
      });
      if (state && state.organizationId !== context.organizationId) {
        throw new AirbnbPostActivationOrchestratorError(
          "AIRBNB_POST_ACTIVATION_PROPERTY_STATE_TENANT_MISMATCH"
        );
      }
      await tx.channexAriPropertyState.upsert({
        where: { propertyId: context.propertyId },
        create: {
          propertyId: context.propertyId,
          organizationId: context.organizationId,
          lastFullSyncRequestedAt: args.now,
        },
        update: { lastFullSyncRequestedAt: args.now },
      });

      await tx.apmsAuditEntry.create({
        data: {
          organizationId: context.organizationId,
          propertyId: context.propertyId,
          entityType: "DISTRIBUTION",
          entityId: context.connectionId,
          engine: "OTA_DISTRIBUTION_AUTOPILOT",
          eventType: "FULL_SYNC_QUEUED",
          status: "SUCCESS",
          severity: "INFO",
          decisionId,
          summary: "Airbnb post-activation canonical Full Sync queued",
          reason: "POST_ACTIVATION_FULL_SYNC",
          metadata: {
            provider: "AIRBNB",
            correlationId: cid,
            trigger: AIRBNB_POST_ACTIVATION_FULL_SYNC_TRIGGER,
            lastChannelActivatedAt: context.activatedAt.toISOString(),
            readinessRevision: context.readinessRevision,
            messageKinds: ["AVAILABILITY", "RATES_RESTRICTIONS"],
          },
          startedAt: args.now,
          completedAt: args.now,
          durationMs: 0,
        },
      });
    },
    { isolationLevel: "Serializable" }
  );

  return { queued: true, correlationId: cid };
}

function fullSyncTerminalFailure(rows: any[]): boolean {
  return rows.some(
    (row) =>
      row.status === "DEAD" ||
      row.delivery?.status === "DEAD"
  );
}

function fullSyncPairSent(rows: any[]): boolean {
  return (
    rows.length === 2 &&
    rows.every(
      (row) => row.status === "MERGED" && row.delivery?.status === "SENT"
    )
  );
}

export async function runAirbnbPostActivationCycle(args: {
  prisma: PrismaClient;
  provider: Provider;
  reconcile: Reconciler;
  limit?: number;
  connectionId?: string;
  now?: Date;
}): Promise<AirbnbPostActivationCycleResult> {
  const now = args.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AirbnbPostActivationOrchestratorError(
      "AIRBNB_POST_ACTIVATION_NOW_INVALID"
    );
  }
  const limit = args.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AirbnbPostActivationOrchestratorError(
      "AIRBNB_POST_ACTIVATION_LIMIT_INVALID"
    );
  }

  const connections = await args.prisma.otaChannelConnection.findMany({
    where: {
      provider: "AIRBNB",
      externalConnectionId: { not: null },
      lastChannelActivatedAt: { not: null },
      status: { notIn: ["ACTIVE", "DISCONNECTED", "DISCONNECTING"] },
      ...(args.connectionId ? { id: args.connectionId } : {}),
    },
    orderBy: { lastChannelActivatedAt: "asc" },
    take: limit,
    include: {
      distributionProperty: {
        include: {
          group: true,
          property: {
            select: {
              id: true,
              organizationId: true,
              status: true,
              timezone: true,
            },
          },
        },
      },
    },
  });

  const result: AirbnbPostActivationCycleResult = {
    scanned: connections.length,
    queued: 0,
    reconciled: 0,
    active: 0,
    items: [],
  };

  for (const connection of connections) {
    const context = validateCandidate(connection);
    if (!context) {
      result.items.push({
        connectionId: String(connection?.id ?? "unknown"),
        outcome: "ACTION_REQUIRED",
        reason: "LOCAL_CONTEXT_INVALID",
      });
      continue;
    }

    const channel = await args.provider.getChannel(context.externalConnectionId);
    const matchingMappings = channel.mappings.filter(
      (mapping) => mapping.ratePlanId === context.externalRatePlanId
    );
    if (
      channel.id !== context.externalConnectionId ||
      channel.isActive !== true ||
      channel.groupId !== context.externalGroupId ||
      channel.propertyIds.length !== 1 ||
      channel.propertyIds[0] !== context.externalPropertyId ||
      matchingMappings.length !== 1 ||
      !text(matchingMappings[0]?.listingId)
    ) {
      result.items.push({
        connectionId: context.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "PROVIDER_ACTIVE_MAPPING_NOT_VERIFIED",
      });
      continue;
    }

    const queue = await queueFullSyncOnce({
      prisma: args.prisma,
      connection,
      context,
      now,
    });
    if (queue.queued) {
      result.queued += 1;
      result.items.push({
        connectionId: context.connectionId,
        outcome: "QUEUED_FULL_SYNC",
        reason: "POST_ACTIVATION_FULL_SYNC",
        correlationId: queue.correlationId,
      });
      continue;
    }

    const rows = await args.prisma.distributionOutboxEvent.findMany({
      where: {
        organizationId: context.organizationId,
        propertyId: context.propertyId,
        provider: "CHANNEX",
        correlationId: queue.correlationId,
      },
      orderBy: { id: "asc" },
      take: 3,
      select: {
        id: true,
        status: true,
        messageKind: true,
        deliveryId: true,
        delivery: { select: { status: true } },
      },
    });
    if (fullSyncTerminalFailure(rows)) {
      result.items.push({
        connectionId: context.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "POST_ACTIVATION_FULL_SYNC_FAILED",
        correlationId: queue.correlationId,
      });
      continue;
    }

    const state = await args.prisma.channexAriPropertyState.findUnique({
      where: { propertyId: context.propertyId },
      select: {
        organizationId: true,
        lastFullSyncRequestedAt: true,
        lastFullSyncCompletedAt: true,
      },
    });
    if (
      !state ||
      state.organizationId !== context.organizationId ||
      !fullSyncPairSent(rows) ||
      !validDate(state.lastFullSyncCompletedAt) ||
      state.lastFullSyncCompletedAt!.getTime() < context.activatedAt.getTime()
    ) {
      result.items.push({
        connectionId: context.connectionId,
        outcome: "WAIT_FULL_SYNC",
        reason: "FULL_SYNC_NOT_YET_CONFIRMED",
        correlationId: queue.correlationId,
      });
      continue;
    }

    await args.reconcile({
      organizationId: context.organizationId,
      propertyId: context.propertyId,
      requestedByUserId: "airbnb-post-auth-autopilot",
      provider: "AIRBNB",
      requestKey: `airbnb-post-activation:${context.connectionId}:r${context.readinessRevision}`,
    });
    result.reconciled += 1;

    const after = await args.prisma.otaChannelConnection.findFirst({
      where: {
        id: context.connectionId,
        organizationId: context.organizationId,
        propertyId: context.propertyId,
        provider: "AIRBNB",
      },
      select: {
        status: true,
        authorizationReadiness: true,
        mappingReadiness: true,
        distributionReadiness: true,
      },
    });

    if (
      after?.status === "ACTIVE" &&
      after.authorizationReadiness === "READY" &&
      after.mappingReadiness === "READY" &&
      after.distributionReadiness === "READY"
    ) {
      result.active += 1;
      result.items.push({
        connectionId: context.connectionId,
        outcome: "ACTIVE",
        reason: "CANONICAL_ACTIVE",
        correlationId: queue.correlationId,
      });
    } else if (after?.distributionReadiness === "BLOCKED") {
      result.items.push({
        connectionId: context.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "CANONICAL_READINESS_BLOCKED",
        correlationId: queue.correlationId,
      });
    } else {
      result.items.push({
        connectionId: context.connectionId,
        outcome: "WAIT_CANONICAL",
        reason: "CANONICAL_NOT_YET_ACTIVE",
        correlationId: queue.correlationId,
      });
    }
  }

  return result;
}
