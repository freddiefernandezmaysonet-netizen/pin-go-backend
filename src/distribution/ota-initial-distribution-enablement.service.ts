import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

type Scope = { organizationId: string; propertyId: string; requestedByUserId: string };
type Reader = Pick<Prisma.TransactionClient,
  "property" | "dashboardUser" | "distributionProperty" | "pmsListing" |
  "channexAriPropertyState" | "distributionOutboxEvent" | "apmsAuditEntry">;
export type InitialDistributionGuard = { fingerprint: string; capturedAt: Date } | null;
export type InitialDistributionEnablement = {
  preflight(input: Scope): Promise<void>;
  capture(input: Scope): Promise<InitialDistributionGuard>;
  complete(input: Scope, guard: InitialDistributionGuard): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);
export class InitialDistributionEnablementError extends Error {
  constructor(readonly code: string) { super(code); this.name = "InitialDistributionEnablementError"; }
}
function fail(reason: string): never {
  throw new InitialDistributionEnablementError(`OTA_INITIAL_DISTRIBUTION_${reason}`);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function decisionId(scope: Scope): string {
  return `ota-initial-distribution:${createHash("sha256")
    .update(JSON.stringify([scope.organizationId, scope.propertyId])).digest("hex")}`;
}
function timestamp(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("TIME_INVALID");
  return new Date(value);
}

async function eligibleProperty(client: Reader, input: Scope) {
  if (Object.values(input).some(value => typeof value !== "string" || !value.trim())) fail("SCOPE_INVALID");
  const actor = await client.dashboardUser.findFirst({
    where: { id: input.requestedByUserId, organizationId: input.organizationId, isActive: true },
    select: { id: true, organizationId: true, isActive: true, role: true },
  });
  if (!actor || actor.id !== input.requestedByUserId || actor.organizationId !== input.organizationId ||
      !actor.isActive || !ADMIN_ROLES.has(actor.role)) fail("ACTOR_FORBIDDEN");
  const property = await client.property.findFirst({
    where: { id: input.propertyId, organizationId: input.organizationId, status: "ACTIVE" },
    select: { id: true, organizationId: true, status: true, timezone: true, updatedAt: true,
      distributionEnabled: true, distributionStatus: true, distributionEnabledAt: true,
      distributionLastSyncedAt: true, distributionLastError: true },
  });
  if (!property || property.id !== input.propertyId || property.organizationId !== input.organizationId ||
      property.status !== "ACTIVE") fail("PROPERTY_NOT_FOUND");
  if (property.distributionEnabled === true && property.distributionStatus === "ACTIVE") return null;
  // Only the never-enabled baseline is eligible. FAILED/PAUSED/inconsistent
  // states and evidence of a previous lifecycle require a separate decision.
  if (property.distributionEnabled !== false || property.distributionStatus !== "DISABLED" ||
      property.distributionEnabledAt !== null || property.distributionLastSyncedAt !== null ||
      property.distributionLastError !== null) fail("REVIEW_REQUIRED");
  const [audit, ari, outbox] = await Promise.all([
    client.apmsAuditEntry.findUnique({ where: { decisionId: decisionId(input) }, select: { id: true } }),
    client.channexAriPropertyState.findUnique({ where: { propertyId: input.propertyId },
      select: { organizationId: true, lastFullSyncRequestedAt: true, lastFullSyncCompletedAt: true } }),
    client.distributionOutboxEvent.findFirst({
      where: { organizationId: input.organizationId, propertyId: input.propertyId, provider: "CHANNEX" },
      select: { id: true },
    }),
  ]);
  if (audit || outbox || (ari && (ari.organizationId !== input.organizationId ||
      ari.lastFullSyncRequestedAt !== null || ari.lastFullSyncCompletedAt !== null))) fail("REVIEW_REQUIRED");
  if (!property.timezone) fail("TIMEZONE_REQUIRED");
  try { new Intl.DateTimeFormat("en", { timeZone: property.timezone }).format(); }
  catch { fail("TIMEZONE_INVALID"); }
  return property;
}

async function mapping(client: Reader, input: Scope, property: NonNullable<Awaited<ReturnType<typeof eligibleProperty>>>) {
  const distribution = await client.distributionProperty.findFirst({
    where: { organizationId: input.organizationId, propertyId: input.propertyId, platform: "CHANNEX" },
    select: { id: true, organizationId: true, propertyId: true, groupId: true, platform: true,
      provisioningStatus: true, lastErrorCode: true, externalPropertyId: true,
      externalPrimaryRoomTypeId: true, externalPrimaryRatePlanId: true,
      group: { select: { id: true, organizationId: true, platform: true, provisioningStatus: true,
        externalGroupId: true } } },
  });
  const group = distribution?.group;
  if (!distribution || !group || distribution.organizationId !== input.organizationId ||
      distribution.propertyId !== input.propertyId || distribution.platform !== "CHANNEX" ||
      distribution.provisioningStatus !== "READY" || distribution.lastErrorCode !== null ||
      distribution.groupId !== group.id || group.organizationId !== input.organizationId ||
      group.platform !== "CHANNEX" || group.provisioningStatus !== "READY") fail("MAPPING_NOT_READY");
  for (const id of [distribution.externalPropertyId, distribution.externalPrimaryRoomTypeId,
    distribution.externalPrimaryRatePlanId, group.externalGroupId]) {
    if (typeof id !== "string" || !UUID.test(id)) fail("MAPPING_INVALID");
  }
  const listings = await client.pmsListing.findMany({
    where: { propertyId: input.propertyId, connection: { provider: "CHANNEX" } }, take: 2,
    select: { id: true, propertyId: true, connectionId: true, externalListingId: true, metadata: true,
      connection: { select: { id: true, organizationId: true, provider: true, status: true } } },
  });
  if (listings.length !== 1) fail("PMS_MAPPING_CONFLICT");
  const listing = listings[0]!;
  const metadata = object(listing.metadata);
  if (listing.propertyId !== input.propertyId || listing.connectionId !== listing.connection.id ||
      listing.connection.organizationId !== input.organizationId || listing.connection.provider !== "CHANNEX" ||
      listing.connection.status !== "ACTIVE" || metadata.provider !== "CHANNEX" ||
      listing.externalListingId !== distribution.externalPrimaryRoomTypeId ||
      metadata.channexPropertyId !== distribution.externalPropertyId ||
      metadata.channexRatePlanId !== distribution.externalPrimaryRatePlanId) fail("PMS_MAPPING_CONFLICT");
  // Registrar writes metadata/updatedAt. Only material identities enter this
  // guard, so verifying the existing webhook cannot invalidate its own work.
  const fingerprint = createHash("sha256").update(JSON.stringify({
    actor: input.requestedByUserId, organization: input.organizationId,
    property: [property.id, property.updatedAt, property.timezone],
    distribution: [distribution.id, group.id, group.externalGroupId, distribution.externalPropertyId,
      distribution.externalPrimaryRoomTypeId, distribution.externalPrimaryRatePlanId],
    listing: [listing.id, listing.connectionId, listing.externalListingId,
      metadata.channexPropertyId, metadata.channexRatePlanId],
  })).digest("hex");
  return { fingerprint, distribution, listing, metadata };
}

export function createInitialDistributionEnablement(
  client: PrismaClient,
  clock: () => Date = () => new Date(),
): InitialDistributionEnablement {
  return {
    async preflight(input) { await eligibleProperty(client, input); },
    async capture(input) {
      return client.$transaction(async tx => {
        const property = await eligibleProperty(tx, input);
        if (!property) return null;
        const evidence = await mapping(tx, input, property);
        return { fingerprint: evidence.fingerprint, capturedAt: timestamp(clock()) };
      }, { isolationLevel: "Serializable" });
    },
    async complete(input, guard) {
      if (!guard) return;
      try {
        await client.$transaction(async tx => {
          const property = await eligibleProperty(tx, input);
          // Another verified preparation may have completed first. Never write
          // an already-active property or duplicate its initial audit entry.
          if (!property) return;
          const evidence = await mapping(tx, input, property);
          if (guard.fingerprint !== evidence.fingerprint) fail("STATE_CONFLICT");
          const now = timestamp(clock());
          const verifiedAt = typeof evidence.metadata.channexBookingWebhookConfiguredAt === "string"
            ? new Date(evidence.metadata.channexBookingWebhookConfiguredAt) : null;
          if (evidence.metadata.channexBookingWebhookVerified !== true || !verifiedAt ||
              !Number.isFinite(verifiedAt.getTime()) || verifiedAt < timestamp(guard.capturedAt) || verifiedAt > now ||
              evidence.metadata.channexBookingWebhookEventMask !== "booking" ||
              evidence.metadata.channexBookingWebhookSendData !== false ||
              typeof evidence.metadata.channexBookingWebhookId !== "string" ||
              !UUID.test(evidence.metadata.channexBookingWebhookId)) fail("WEBHOOK_NOT_VERIFIED");
          const updated = await tx.property.updateMany({
            where: { id: input.propertyId, organizationId: input.organizationId, status: "ACTIVE",
              updatedAt: property.updatedAt, distributionEnabled: false, distributionStatus: "DISABLED",
              distributionEnabledAt: null, distributionLastSyncedAt: null, distributionLastError: null },
            data: { distributionEnabled: true, distributionStatus: "ACTIVE", distributionEnabledAt: now },
          });
          if (updated.count !== 1) fail("STATE_CONFLICT");
          await tx.apmsAuditEntry.create({ data: {
            organizationId: input.organizationId, propertyId: input.propertyId,
            entityType: "DISTRIBUTION", entityId: evidence.distribution.id, engine: "OTA_DISTRIBUTION",
            eventType: "INITIAL_DISTRIBUTION_ENABLED", status: "SUCCESS", severity: "INFO",
            decisionId: decisionId(input), reason: "CANONICAL_CONNECTION_CENTER_INITIAL_ENABLEMENT",
            summary: "Initial internal distribution enabled after canonical preparation and webhook verification",
            startedAt: guard.capturedAt, completedAt: now,
            metadata: { requestedByUserId: input.requestedByUserId, pmsListingId: evidence.listing.id,
              inventoryReprovisionedByEnablement: false, otaActivationPerformed: false, fullSyncRequested: false },
          } });
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (error instanceof InitialDistributionEnablementError) throw error;
        // No automatic retry: a new authenticated preparation rechecks evidence.
        // Do not propagate raw Prisma/provider payloads through the host API.
        fail("PERSISTENCE_CONFLICT");
      }
    },
  };
}
