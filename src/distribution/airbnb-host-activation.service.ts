import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { validateChannexAriCanonicalMapping } from "./channex-airbnb-transport-readiness.policy.js";
import { CHANNEX_ARI_FULL_SYNC_DAYS } from "../pms/outbound/channex-ari-lifecycle.policy.js";
import { calculateChannexAriCanonicalJsonIntegrity } from "../pms/outbound/channex-ari-canonical-json.policy.js";
import type { ChannexReadonlyTransport } from "./channex-readonly.http-transport.js";
import { AirbnbActivationError, type AirbnbActivationTransport } from "./airbnb-host-activation.http-transport.js";
import {
  CHANNEX_CHANNEL_LIFECYCLE_APPLIED_AUDIT_SUMMARY,
  CHANNEX_CHANNEL_LIFECYCLE_SKIPPED_AUDIT_SUMMARY,
  CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE,
  CHANNEX_CHANNEL_LIFECYCLE_EVENTS,
  isChannexFullSyncInvalidatingLifecycleEvent,
  latestChannexFullSyncInvalidationAuditEvidence,
  type ChannexChannelLifecycleEventType,
  type ChannexFullSyncInvalidationEvidence,
} from "./channex-channel-lifecycle.evidence.js";

export const AIRBNB_ACTIVATION_CONFIRMATION = "CONFIRM_AIRBNB_ACTIVATION";
export const AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION = "VERIFY_AIRBNB_ACTIVATION";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Scope = { organizationId: string; propertyId: string };
type Readers = Pick<PrismaClient, "distributionProperty" | "otaChannelConnection" | "pmsListing" | "channexAriPropertyState" | "distributionOutboxEvent" | "apmsAuditEntry">;
type Dependencies = Scope & { client: PrismaClient; readonlyTransport: Pick<ChannexReadonlyTransport, "getChannel">; now?: Date };
export type AirbnbActivationState = {
  status: "READY" | "ACTIVE" | "NOT_READY" | "CHECK_REQUIRED";
  reason: string | null;
  channelId: string;
  mappingId: string | null;
  listingId: string | null;
};
export type AirbnbActivationResult = {
  outcome: "ACTIVATED" | "ALREADY_ACTIVE" | "VERIFIED";
  channelActive: true;
  readinessChecked: boolean;
};
function fail(reason: string): never { throw new AirbnbActivationError(`OTA_AIRBNB_ACTIVATION_${reason}`); }
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const AIRBNB_FULL_SYNC_INVALIDATING_LIFECYCLE_EVENTS =
  CHANNEX_CHANNEL_LIFECYCLE_EVENTS.filter(eventType =>
    isChannexFullSyncInvalidatingLifecycleEvent("AIRBNB", eventType));

type LifecycleWatermark = ChannexFullSyncInvalidationEvidence;

function lifecycleWatermark(connection: Record<string, any>): LifecycleWatermark | null | false {
  const values = [
    connection.lastLifecycleOccurredAt,
    connection.lastLifecycleOccurredAtMicros,
    connection.lastLifecycleEventType,
    connection.lastLifecycleEventPrecedence,
  ];
  if (values.every(value => value == null)) return null;
  if (values.some(value => value == null)) return false;
  const occurredAt = new Date(connection.lastLifecycleOccurredAt);
  let occurredAtMicros: bigint;
  try { occurredAtMicros = BigInt(connection.lastLifecycleOccurredAtMicros); } catch { return false; }
  const eventType = connection.lastLifecycleEventType as ChannexChannelLifecycleEventType;
  const precedence = connection.lastLifecycleEventPrecedence;
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.getTime() < 0 ||
    occurredAtMicros < 0n ||
    occurredAtMicros / 1000n !== BigInt(occurredAt.getTime()) ||
    !(CHANNEX_CHANNEL_LIFECYCLE_EVENTS as readonly string[]).includes(eventType) ||
    !Number.isInteger(precedence) ||
    CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE[eventType] !== precedence
  ) return false;
  return { eventType, occurredAt, occurredAtMicros, precedence };
}

function compareLifecycle(
  left: LifecycleWatermark,
  right: LifecycleWatermark,
): number {
  if (left.occurredAtMicros !== right.occurredAtMicros) {
    return left.occurredAtMicros > right.occurredAtMicros ? 1 : -1;
  }
  return left.precedence - right.precedence;
}

function lifecycleFrontierAt(evidence: ChannexFullSyncInvalidationEvidence): Date | null {
  const milliseconds = Number((evidence.occurredAtMicros + 999n) / 1000n);
  return Number.isSafeInteger(milliseconds) ? new Date(milliseconds) : null;
}

function validDate(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()) || value.getTime() < 0) return null;
  return new Date(value);
}

function latestDate(values: unknown[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const date = validDate(value);
    if (!date) return null;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

async function context(client: Readers, input: Scope) {
  const scope = { organizationId: input.organizationId, propertyId: input.propertyId };
  if (!scope.organizationId || !scope.propertyId) fail("TENANT_INVALID");
  const [dp, connection, listings, state] = await Promise.all([
    client.distributionProperty.findFirst({
      where: { ...scope, platform: "CHANNEX" },
      select: {
        id: true, organizationId: true, propertyId: true, groupId: true, platform: true, provisioningStatus: true, updatedAt: true,
        externalPropertyId: true, externalPrimaryRoomTypeId: true, externalPrimaryRatePlanId: true,
        group: { select: { id: true, organizationId: true, platform: true, provisioningStatus: true, externalGroupId: true, updatedAt: true } },
        property: { select: { id: true, organizationId: true, distributionEnabled: true, distributionStatus: true, timezone: true } },
      },
    }),
    client.otaChannelConnection.findFirst({
      where: { ...scope, provider: "AIRBNB" },
      select: { id: true, organizationId: true, propertyId: true, distributionPropertyId: true, provider: true,
        status: true, externalConnectionId: true, externalListingId: true, readinessRevision: true, updatedAt: true, activationRequestedAt: true,
        lastLifecycleOccurredAt: true, lastLifecycleOccurredAtMicros: true, lastLifecycleEventType: true, lastLifecycleEventPrecedence: true },
    }),
    client.pmsListing.findMany({
      where: { propertyId: scope.propertyId, connection: { provider: "CHANNEX" } },
      take: 2, select: { id: true, connectionId: true, propertyId: true, externalListingId: true, metadata: true, updatedAt: true,
        connection: { select: { id: true, organizationId: true, provider: true, status: true, updatedAt: true } } },
    }),
    client.channexAriPropertyState.findUnique({ where: { propertyId: scope.propertyId },
      select: { organizationId: true, propertyId: true, lastFullSyncRequestedAt: true, lastFullSyncCompletedAt: true } }),
  ]);
  if (!dp || !connection || !dp.group) fail("CONTEXT_NOT_FOUND");
  if (dp.organizationId !== scope.organizationId || dp.propertyId !== scope.propertyId ||
      dp.platform !== "CHANNEX" || dp.provisioningStatus !== "READY" ||
      dp.property.organizationId !== scope.organizationId || dp.property.id !== scope.propertyId ||
      !dp.property.distributionEnabled || dp.property.distributionStatus !== "ACTIVE" ||
      dp.groupId !== dp.group.id || dp.group.organizationId !== scope.organizationId ||
      dp.group.platform !== "CHANNEX" || dp.group.provisioningStatus !== "READY" ||
      connection.organizationId !== scope.organizationId || connection.propertyId !== scope.propertyId ||
      connection.distributionPropertyId !== dp.id || connection.provider !== "AIRBNB") fail("CONTEXT_CONFLICT");
  if (["FAILED", "DISCONNECTING", "DISCONNECTED"].includes(connection.status)) fail("CONTEXT_CONFLICT");
  for (const id of [dp.externalPropertyId, dp.externalPrimaryRoomTypeId, dp.externalPrimaryRatePlanId, dp.group.externalGroupId, connection.externalConnectionId]) {
    if (typeof id !== "string" || !UUID.test(id)) fail("CONTEXT_CONFLICT");
  }
  if (listings.length !== 1) fail("PMS_MAPPING_CONFLICT");
  const listing = listings[0]!;
  if (!validateChannexAriCanonicalMapping({ expectedOrganizationId: scope.organizationId, expectedPropertyId: scope.propertyId,
    distributionProperty: dp, pmsListing: listing, pmsConnection: listing.connection }).verified) fail("PMS_MAPPING_CONFLICT");
  const invalidationAudits = await client.apmsAuditEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      entityType: "DISTRIBUTION",
      entityId: connection.id,
      engine: "OTA_DISTRIBUTION",
      eventType: { in: ["DECISION_APPLIED", "DECISION_SKIPPED"] },
      status: "SUCCESS",
      summary: {
        in: [
          CHANNEX_CHANNEL_LIFECYCLE_APPLIED_AUDIT_SUMMARY,
          CHANNEX_CHANNEL_LIFECYCLE_SKIPPED_AUDIT_SUMMARY,
        ],
      },
      reason: { in: [...AIRBNB_FULL_SYNC_INVALIDATING_LIFECYCLE_EVENTS] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      organizationId: true,
      propertyId: true,
      entityType: true,
      entityId: true,
      engine: true,
      eventType: true,
      status: true,
      summary: true,
      reason: true,
      metadata: true,
    },
  });
  const watermark = lifecycleWatermark(connection);
  let invalidation: ChannexFullSyncInvalidationEvidence | null = null;
  let lifecycleEvidenceValid = watermark !== false;
  if (lifecycleEvidenceValid) {
    try {
      invalidation = latestChannexFullSyncInvalidationAuditEvidence(invalidationAudits, {
        organizationId: scope.organizationId,
        propertyId: scope.propertyId,
        connectionId: connection.id,
        provider: "AIRBNB",
        externalPropertyId: dp.externalPropertyId!,
        externalConnectionId: connection.externalConnectionId!,
      });
    } catch {
      lifecycleEvidenceValid = false;
    }
  }
  if (lifecycleEvidenceValid && (!invalidation || !watermark)) {
    lifecycleEvidenceValid = false;
  } else if (lifecycleEvidenceValid && watermark !== false && watermark && invalidation) {
    lifecycleEvidenceValid = isChannexFullSyncInvalidatingLifecycleEvent("AIRBNB", watermark.eventType)
      ? compareLifecycle(invalidation, watermark) === 0
      : compareLifecycle(invalidation, watermark) < 0;
  }
  const events = state?.lastFullSyncRequestedAt ? await client.distributionOutboxEvent.findMany({
    where: { ...scope, provider: "CHANNEX", syncMode: "FULL", createdAt: { gte: state.lastFullSyncRequestedAt } },
    orderBy: { createdAt: "asc" }, take: 3, include: { delivery: true },
  }) : [];
  // Only local identities and the completed ARI pair enter the concurrency guard.
  // Unrelated credentials/connection metadata are neither hashed nor returned.
  const signature = fingerprint({
    dp: [dp.id, dp.updatedAt, dp.externalPropertyId, dp.externalPrimaryRoomTypeId, dp.externalPrimaryRatePlanId],
    group: [dp.group.id, dp.group.updatedAt, dp.group.externalGroupId],
    // activationRequestedAt and updatedAt intentionally stay outside this
    // material signature: the durable claim changes both before the POST.
    connection: [connection.id, connection.externalConnectionId, connection.externalListingId, connection.status, connection.readinessRevision,
      connection.lastLifecycleOccurredAt, connection.lastLifecycleOccurredAtMicros?.toString(), connection.lastLifecycleEventType,
      connection.lastLifecycleEventPrecedence],
    listing: [listing.id, listing.updatedAt, listing.connectionId, listing.externalListingId,
      record(listing.metadata).channexPropertyId, record(listing.metadata).channexRatePlanId,
      listing.connection.id, listing.connection.updatedAt],
    invalidation: [lifecycleEvidenceValid, invalidation?.eventType, invalidation?.occurredAt,
      invalidation?.occurredAtMicros.toString(), invalidation?.precedence],
    state: [state?.lastFullSyncRequestedAt, state?.lastFullSyncCompletedAt],
    events: events.map(e => [e.id, e.status, e.deliveryId, e.delivery?.status, e.delivery?.payloadHash]),
  });
  return { dp, group: dp.group, connection, listing, state, events, invalidation, lifecycleEvidenceValid, signature };
}
type Context = Awaited<ReturnType<typeof context>>;

function fullSyncReady(c: Context, scope: Scope, now: Date): boolean {
  const { state, events, dp, group, listing, invalidation, lifecycleEvidenceValid } = c;
  const mappingLastChangedAt = latestDate([
    dp.updatedAt,
    group.updatedAt,
    listing.updatedAt,
    listing.connection.updatedAt,
  ]);
  const invalidationFrontierAt = invalidation ? lifecycleFrontierAt(invalidation) : null;
  const evidenceFrontierAt = mappingLastChangedAt && lifecycleEvidenceValid && (!invalidation || invalidationFrontierAt)
    ? new Date(Math.max(mappingLastChangedAt.getTime(), invalidationFrontierAt?.getTime() ?? 0))
    : null;
  if (!state || state.organizationId !== scope.organizationId || state.propertyId !== scope.propertyId ||
      !state.lastFullSyncRequestedAt || !state.lastFullSyncCompletedAt || events.length !== 2 ||
      !validDate(state.lastFullSyncRequestedAt) || !validDate(state.lastFullSyncCompletedAt) ||
      !validDate(now) || !evidenceFrontierAt ||
      state.lastFullSyncRequestedAt <= evidenceFrontierAt ||
      state.lastFullSyncCompletedAt < state.lastFullSyncRequestedAt || state.lastFullSyncCompletedAt > now) return false;
  if (!events[0]?.correlationId || events[0].correlationId !== events[1]?.correlationId ||
      new Set(events.map(e => e.messageKind)).size !== 2 || new Set(events.map(e => e.deliveryId)).size !== 2) return false;
  if (!dp.property.timezone) return false;
  const today = formatInTimeZone(now, dp.property.timezone, "yyyy-MM-dd");
  return events.every(e => {
    const d = e.delivery;
    if (!d || !["AVAILABILITY", "RATES_RESTRICTIONS"].includes(e.messageKind) ||
        e.organizationId !== scope.organizationId || e.propertyId !== scope.propertyId || e.provider !== "CHANNEX" ||
        e.status !== "MERGED" || e.syncMode !== "FULL" || e.scope !== "FULL_HORIZON" ||
        d.organizationId !== scope.organizationId || d.propertyId !== scope.propertyId ||
        d.connectionId !== listing.connectionId || d.listingId !== listing.id || d.id !== e.deliveryId ||
        d.status !== "SENT" || d.httpStatus !== 200 || d.warningCount !== 0 || d.messageKind !== e.messageKind ||
        d.syncMode !== "FULL" || d.scope !== "FULL_HORIZON" || !d.sentAt || d.sentAt < state.lastFullSyncRequestedAt! ||
        d.sentAt > state.lastFullSyncCompletedAt! || !d.dateFrom || !d.dateToExclusive ||
        d.dateFrom.getTime() !== e.dateFrom?.getTime() || d.dateToExclusive.getTime() !== e.dateToExclusive?.getTime() ||
        d.dateFrom.getTime() !== events[0]?.dateFrom?.getTime() || d.dateToExclusive.getTime() !== events[0]?.dateToExclusive?.getTime() ||
        (d.dateToExclusive.getTime() - d.dateFrom.getTime()) / 86400000 !== CHANNEX_ARI_FULL_SYNC_DAYS ||
        d.dateFrom.toISOString().slice(0, 10) !== today) return false;
    const payload = record(d.payload);
    const values = payload.values;
    if (!Array.isArray(values) || values.length === 0 || !values.every(v =>
      record(v).property_id === dp.externalPropertyId &&
      (e.messageKind === "AVAILABILITY" ? record(v).room_type_id === dp.externalPrimaryRoomTypeId : record(v).rate_plan_id === dp.externalPrimaryRatePlanId))) return false;
    const integrity = calculateChannexAriCanonicalJsonIntegrity(d.payload);
    if (integrity.payloadHash !== d.payloadHash || integrity.payloadBytes !== d.payloadBytes || values.length !== d.payloadValueCount) return false;
    const covered = new Set<string>();
    for (const raw of values) {
      const v = record(raw);
      const from = v.date ?? v.date_from;
      const to = v.date ?? v.date_to;
      if (typeof from !== "string" || typeof to !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
      const first = new Date(`${from}T00:00:00Z`), last = new Date(`${to}T00:00:00Z`);
      if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) ||
          first.toISOString().slice(0, 10) !== from || last.toISOString().slice(0, 10) !== to ||
          first > last || first < d.dateFrom || last >= d.dateToExclusive) return false;
      for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
        const key = new Date(t).toISOString().slice(0, 10);
        if (covered.has(key)) return false;
        covered.add(key);
      }
    }
    return covered.size === CHANNEX_ARI_FULL_SYNC_DAYS;
  });
}

type ObservedAirbnbActivationState = AirbnbActivationState & { providerActive: boolean };

function channelState(payload: unknown, c: Context): ObservedAirbnbActivationState {
  const data = record(record(payload).data);
  const a = record(data.attributes);
  const group = record(record(record(data.relationships).group).data);
  if (data.type !== "channel" || data.id !== c.connection.externalConnectionId ||
      typeof a.channel !== "string" || a.channel.toLowerCase() !== "airbnb" || typeof a.is_active !== "boolean" ||
      group.type !== "group" || group.id !== c.group.externalGroupId ||
      !Array.isArray(a.properties) || !a.properties.includes(c.dp.externalPropertyId) ||
      !Array.isArray(a.rate_plans)) fail("CHANNEL_STATE_CONFLICT");
  // Activation affects the whole channel. This property-scoped action cannot
  // activate a shared channel's other properties or rate plans implicitly.
  if (a.properties.length !== 1 || a.rate_plans.some((m: unknown) => record(m).rate_plan_id !== c.dp.externalPrimaryRatePlanId)) {
    fail("SHARED_CHANNEL_SCOPE_CONFLICT");
  }
  if (a.rate_plans.length === 0) return { status: "NOT_READY", reason: "MAPPING_REQUIRED", channelId: data.id, mappingId: null, listingId: null, providerActive: a.is_active };
  if (a.rate_plans.length !== 1) fail("MAPPING_CONFLICT");
  const m = record(a.rate_plans[0]);
  const listingId = String(record(m.settings).listing_id ?? "");
  if (typeof m.id !== "string" || !UUID.test(m.id) || !/^\d{1,32}$/.test(listingId) ||
      (c.connection.externalListingId && c.connection.externalListingId !== listingId)) fail("MAPPING_CONFLICT");
  return { status: c.connection.activationRequestedAt ? "CHECK_REQUIRED" : a.is_active ? "ACTIVE" : "READY",
    reason: null, channelId: data.id, mappingId: m.id, listingId, providerActive: a.is_active };
}

function publicState(observed: ObservedAirbnbActivationState): AirbnbActivationState {
  const { providerActive: _providerActive, ...state } = observed;
  return state;
}

export async function inspectAirbnbActivation(args: Dependencies): Promise<AirbnbActivationState> {
  const c = await context(args.client, args);
  const result = channelState(await args.readonlyTransport.getChannel(c.connection.externalConnectionId!), c);
  if (result.status === "READY" && !fullSyncReady(c, args, args.now ?? new Date())) {
    return { ...publicState(result), status: "NOT_READY", reason: "FULL_SYNC_REQUIRED" };
  }
  return publicState(result);
}

type ActivationAuditBase = {
  organizationId: string;
  propertyId: string;
  entityType: "DISTRIBUTION";
  entityId: string;
  engine: "OTA_DISTRIBUTION";
  metadata: Prisma.InputJsonObject;
};

function activationAuditBase(args: Scope & { requestedByUserId: string }, c: Context, identity: {
  channelId: string;
  mappingId: string;
  listingId: string;
}): ActivationAuditBase {
  return {
    organizationId: args.organizationId,
    propertyId: args.propertyId,
    entityType: "DISTRIBUTION",
    entityId: c.connection.id,
    engine: "OTA_DISTRIBUTION",
    metadata: {
      requestedByUserId: args.requestedByUserId,
      channelId: identity.channelId,
      mappingId: identity.mappingId,
      listingId: identity.listingId,
      source: "HOST_ACTIVATION",
    },
  };
}

async function markActivationUnverified(args: Dependencies, c: Context, input: {
  decisionId: string;
  requestedAt: Date;
  definitive: boolean;
}) {
  const completedAt = new Date();
  await args.client.$transaction(async tx => {
    await tx.apmsAuditEntry.updateMany({
      where: {
        decisionId: input.decisionId,
        organizationId: args.organizationId,
        propertyId: args.propertyId,
        entityId: c.connection.id,
        eventType: "ACTIVATION_REQUESTED",
        status: { in: ["PENDING", "UNKNOWN"] },
      },
      data: {
        status: input.definitive ? "FAILED" : "UNKNOWN",
        reason: "ACTIVATION_NOT_VERIFIED",
        completedAt,
      },
    });
    if (input.definitive) {
      await tx.otaChannelConnection.updateMany({
        where: {
          id: c.connection.id,
          organizationId: args.organizationId,
          propertyId: args.propertyId,
          provider: "AIRBNB",
          externalConnectionId: c.connection.externalConnectionId,
          activationRequestedAt: input.requestedAt,
        },
        data: { activationRequestedAt: null },
      });
    }
  });
}

async function finalizeActivationVerified(args: Dependencies, c: Context, input: {
  requestedDecisionId?: string;
  verifiedDecisionId: string;
  auditBase: ActivationAuditBase;
  claimedAt?: Date | null;
  fullSyncRequiredAt?: Date | null;
}) {
  const completedAt = new Date();
  await args.client.$transaction(async tx => {
    const current = await context(tx, args);
    if (
      current.dp.externalPropertyId !== c.dp.externalPropertyId ||
      current.connection.externalConnectionId !== c.connection.externalConnectionId ||
      current.dp.externalPrimaryRatePlanId !== c.dp.externalPrimaryRatePlanId ||
      current.listing.id !== c.listing.id ||
      (input.fullSyncRequiredAt &&
        !fullSyncReady(current, args, input.fullSyncRequiredAt))
    ) {
      throw new AirbnbActivationError(
        "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED",
        true
      );
    }
    if (input.claimedAt) {
      const currentClaim = current.connection.activationRequestedAt;
      if (
        !validDate(input.claimedAt) ||
        !validDate(currentClaim) ||
        currentClaim!.getTime() !== input.claimedAt.getTime()
      ) {
        throw new AirbnbActivationError(
          "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED",
          true
        );
      }
      const released = await tx.otaChannelConnection.updateMany({
        where: {
          id: c.connection.id,
          organizationId: args.organizationId,
          propertyId: args.propertyId,
          provider: "AIRBNB",
          externalConnectionId: c.connection.externalConnectionId,
          activationRequestedAt: input.claimedAt,
        },
        data: { activationRequestedAt: null },
      });
      if (released.count !== 1) {
        throw new AirbnbActivationError(
          "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED",
          true
        );
      }
    }
    await tx.apmsAuditEntry.upsert({
      where: { decisionId: input.verifiedDecisionId },
      update: {},
      create: {
        ...input.auditBase,
        decisionId: input.verifiedDecisionId,
        eventType: "ACTIVATION_VERIFIED",
        status: "SUCCESS",
        summary: "Exact channel and mapping verified active by GET; commercial readiness remains canonical",
        completedAt,
      },
    });
    if (input.requestedDecisionId) {
      await tx.apmsAuditEntry.updateMany({
        where: {
          decisionId: input.requestedDecisionId,
          organizationId: args.organizationId,
          propertyId: args.propertyId,
          entityId: c.connection.id,
          eventType: "ACTIVATION_REQUESTED",
          status: { in: ["PENDING", "UNKNOWN"] },
        },
        data: { status: "SUCCESS", reason: null, completedAt },
      });
    }
  }, { isolationLevel: "Serializable" });
}

export async function activateAirbnbForHost(args: Dependencies & {
  activationTransport: AirbnbActivationTransport;
  channelId: string; mappingId: string; listingId: string; confirmation: string;
  requestedByUserId: string; requestKey: string;
  reconcile(): Promise<unknown>;
}): Promise<AirbnbActivationResult> {
  if (args.confirmation !== AIRBNB_ACTIVATION_CONFIRMATION || !args.requestedByUserId || !args.requestKey) fail("CONFIRMATION_REQUIRED");
  const now = args.now ?? new Date();
  const c = await context(args.client, args);
  if (c.connection.activationRequestedAt) fail("RECONCILIATION_REQUIRED");
  const check = (payload: unknown) => {
    const state = channelState(payload, c);
    if (state.channelId !== args.channelId || state.mappingId !== args.mappingId || state.listingId !== args.listingId) fail("CONFIRMATION_CONFLICT");
    return state;
  };
  let observed = check(await args.readonlyTransport.getChannel(c.connection.externalConnectionId!));
  const wasActive = observed.providerActive;
  if (!wasActive && !fullSyncReady(c, args, now)) fail("FULL_SYNC_REQUIRED");
  const decisionId = `airbnb-host-activation:${fingerprint([args.organizationId, args.propertyId, c.connection.id, args.requestKey])}`;
  const auditBase = activationAuditBase(args, c, args);

  if (!wasActive) {
    if (observed.status !== "READY") fail("RECONCILIATION_REQUIRED");
    await args.client.$transaction(async tx => {
      const current = await context(tx, args);
      if (current.signature !== c.signature || !fullSyncReady(current, args, now)) fail("CONTEXT_CONFLICT");
      if (await tx.apmsAuditEntry.findUnique({ where: { decisionId } })) fail("RECONCILIATION_REQUIRED");
      const claim = await tx.otaChannelConnection.updateMany({
        where: { id: c.connection.id, organizationId: args.organizationId, propertyId: args.propertyId,
          provider: "AIRBNB", externalConnectionId: args.channelId, updatedAt: c.connection.updatedAt, activationRequestedAt: null },
        data: { activationRequestedAt: now },
      });
      if (claim.count !== 1) fail("CONTEXT_CONFLICT");
      await tx.apmsAuditEntry.create({ data: { ...auditBase, decisionId, eventType: "ACTIVATION_REQUESTED", status: "PENDING", startedAt: now } });
    }, { isolationLevel: "Serializable" });
    try {
      // Re-read after the durable claim. No transaction is held across HTTP.
      const latest = await context(args.client, args);
      if (latest.signature !== c.signature ||
          latest.connection.activationRequestedAt?.getTime() !== now.getTime() ||
          !fullSyncReady(latest, args, now)) fail("CONTEXT_CONFLICT");
      observed = check(await args.readonlyTransport.getChannel(args.channelId));
      if (observed.status !== "ACTIVE") await args.activationTransport.activate(args.channelId);
    } catch (error) {
      // A timeout/malformed success may follow a successful activation.
      // Verification below is GET-only; never replay the POST automatically.
      let verified = false;
      try { verified = check(await args.readonlyTransport.getChannel(args.channelId)).providerActive; } catch { /* uncertain */ }
      if (!verified) {
        const rejected = error instanceof AirbnbActivationError && !error.uncertain;
        await markActivationUnverified(args, c, { decisionId, requestedAt: now, definitive: rejected });
        if (rejected) throw error;
        throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true);
      }
    }
  }
  try {
    observed = check(await args.readonlyTransport.getChannel(args.channelId));
    if (!observed.providerActive) throw new Error("not active");
    const current = await context(args.client, args);
    if (current.dp.externalPropertyId !== c.dp.externalPropertyId || current.connection.externalConnectionId !== args.channelId ||
        current.dp.externalPrimaryRatePlanId !== c.dp.externalPrimaryRatePlanId || current.listing.id !== c.listing.id) throw new Error("identity changed");
    await finalizeActivationVerified(args, c, {
      requestedDecisionId: wasActive ? undefined : decisionId,
      verifiedDecisionId: `${decisionId}:verified`,
      auditBase,
      claimedAt: wasActive ? null : now,
      fullSyncRequiredAt: wasActive ? null : now,
    });
  } catch (error) {
    if (!wasActive) {
      await markActivationUnverified(args, c, { decisionId, requestedAt: now, definitive: false });
    }
    if (error instanceof AirbnbActivationError && !error.uncertain) throw error;
    throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true);
  }
  let readinessChecked = false;
  try { await args.reconcile(); readinessChecked = true; } catch { /* Verified activation survives a failed readiness check. */ }
  // Do not manufacture lifecycle events, lastChannelActivatedAt or commercial ACTIVE.
  return { outcome: wasActive ? "ALREADY_ACTIVE" : "ACTIVATED", channelActive: true, readinessChecked };
}

export async function verifyAirbnbActivationForHost(args: Dependencies & {
  channelId: string;
  mappingId: string;
  listingId: string;
  confirmation: string;
  requestedByUserId: string;
  requestKey: string;
  reconcile(): Promise<unknown>;
}): Promise<AirbnbActivationResult> {
  if (args.confirmation !== AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION || !args.requestedByUserId || !args.requestKey) {
    fail("CONFIRMATION_REQUIRED");
  }
  const c = await context(args.client, args);
  const openAudits = await args.client.apmsAuditEntry.findMany({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      entityType: "DISTRIBUTION",
      entityId: c.connection.id,
      engine: "OTA_DISTRIBUTION",
      eventType: "ACTIVATION_REQUESTED",
      status: { in: ["PENDING", "UNKNOWN"] },
    },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { decisionId: true, metadata: true },
  });
  if (openAudits.length !== 1) fail("RECONCILIATION_REQUIRED");
  const originalIdentity = record(openAudits[0]!.metadata);
  if (
    originalIdentity.source !== "HOST_ACTIVATION" ||
    originalIdentity.channelId !== args.channelId ||
    originalIdentity.mappingId !== args.mappingId ||
    originalIdentity.listingId !== args.listingId
  ) fail("RECONCILIATION_REQUIRED");
  const observed = channelState(await args.readonlyTransport.getChannel(c.connection.externalConnectionId!), c);
  if (observed.channelId !== args.channelId || observed.mappingId !== args.mappingId || observed.listingId !== args.listingId) {
    fail("CONFIRMATION_CONFLICT");
  }
  if (!observed.providerActive) {
    await args.client.apmsAuditEntry.updateMany({
      where: { decisionId: openAudits[0]!.decisionId, status: { in: ["PENDING", "UNKNOWN"] } },
      data: { status: "UNKNOWN", reason: "ACTIVATION_NOT_VERIFIED", completedAt: new Date() },
    });
    throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", true);
  }
  const auditBase = activationAuditBase(args, c, args);
  await finalizeActivationVerified(args, c, {
    requestedDecisionId: openAudits[0]!.decisionId,
    verifiedDecisionId: `${openAudits[0]!.decisionId}:verified`,
    auditBase,
    claimedAt: c.connection.activationRequestedAt,
  });
  let readinessChecked = false;
  try { await args.reconcile(); readinessChecked = true; } catch { /* Verified activation survives a failed readiness check. */ }
  return { outcome: "VERIFIED", channelActive: true, readinessChecked };
}
