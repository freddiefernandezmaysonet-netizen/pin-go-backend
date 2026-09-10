import type { PrismaClient } from "@prisma/client";

import {
  runAirbnbPostAuthOwnerCycle,
  type EnrollmentAudit,
  type LocalContext,
  type OwnerAudit,
  type OwnerStore,
  type Provider,
} from "./airbnb-post-auth-autopilot.owner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[A-Za-z0-9_-]{8,128}$/;
const LISTING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

export const AIRBNB_MAPPING_CANARY_CONFIRMATION =
  "I_UNDERSTAND_ONE_AIRBNB_MAPPING_WRITE" as const;

export type AirbnbMappingCanaryTarget = {
  organizationId: string;
  propertyId: string;
  connectionId: string;
  channelId: string;
  externalPropertyId: string;
  externalGroupId: string;
  ratePlanId: string;
  listingId: string;
};

export class AirbnbPostAuthCanaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbPostAuthCanaryError";
  }
}

function required(value: string | undefined, code: string): string {
  const out = String(value ?? "").trim();
  if (!out) throw new AirbnbPostAuthCanaryError(code);
  return out;
}

function localId(value: string | undefined, code: string): string {
  const out = required(value, code);
  if (!LOCAL_ID.test(out)) throw new AirbnbPostAuthCanaryError(code);
  return out;
}

function uuid(value: string | undefined, code: string): string {
  const out = required(value, code);
  if (!UUID.test(out)) throw new AirbnbPostAuthCanaryError(code);
  return out;
}

function listingId(value: string | undefined, code: string): string {
  const out = required(value, code);
  if (!LISTING_ID.test(out)) throw new AirbnbPostAuthCanaryError(code);
  return out;
}

export function parseAirbnbMappingCanaryArgs(
  argv: readonly string[]
): AirbnbMappingCanaryTarget {
  const allowed = new Set([
    "mode",
    "confirm",
    "organization-id",
    "property-id",
    "connection-id",
    "channel-id",
    "external-property-id",
    "external-group-id",
    "rate-plan-id",
    "listing-id",
  ]);
  const values = new Map<string, string>();

  for (const raw of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(String(raw));
    if (!match || !allowed.has(match[1]!)) {
      throw new AirbnbPostAuthCanaryError("CANARY_ARGUMENT_INVALID");
    }
    if (values.has(match[1]!)) {
      throw new AirbnbPostAuthCanaryError("CANARY_ARGUMENT_DUPLICATE");
    }
    values.set(match[1]!, match[2]!);
  }

  if (values.get("mode") !== "mapping-only") {
    throw new AirbnbPostAuthCanaryError("CANARY_MODE_NOT_AUTHORIZED");
  }
  if (values.get("confirm") !== AIRBNB_MAPPING_CANARY_CONFIRMATION) {
    throw new AirbnbPostAuthCanaryError("CANARY_CONFIRMATION_REQUIRED");
  }

  return {
    organizationId: localId(
      values.get("organization-id"),
      "CANARY_ORGANIZATION_ID_INVALID"
    ),
    propertyId: localId(
      values.get("property-id"),
      "CANARY_PROPERTY_ID_INVALID"
    ),
    connectionId: localId(
      values.get("connection-id"),
      "CANARY_CONNECTION_ID_INVALID"
    ),
    channelId: uuid(values.get("channel-id"), "CANARY_CHANNEL_ID_INVALID"),
    externalPropertyId: uuid(
      values.get("external-property-id"),
      "CANARY_EXTERNAL_PROPERTY_ID_INVALID"
    ),
    externalGroupId: uuid(
      values.get("external-group-id"),
      "CANARY_EXTERNAL_GROUP_ID_INVALID"
    ),
    ratePlanId: uuid(
      values.get("rate-plan-id"),
      "CANARY_RATE_PLAN_ID_INVALID"
    ),
    listingId: listingId(
      values.get("listing-id"),
      "CANARY_LISTING_ID_INVALID"
    ),
  };
}

export function assertAirbnbMappingCanaryEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  providerOrigin: string
): void {
  if (env.NODE_ENV !== "production") {
    throw new AirbnbPostAuthCanaryError("CANARY_REQUIRES_PRODUCTION_ENVIRONMENT");
  }
  if (env.OTA_AIRBNB_POST_AUTH_AUTOPILOT_ENABLED === "true") {
    throw new AirbnbPostAuthCanaryError("CANARY_GLOBAL_AUTOPILOT_MUST_BE_OFF");
  }
  if (String(providerOrigin).replace(/\/$/, "") !== "https://app.channex.io") {
    throw new AirbnbPostAuthCanaryError("CANARY_REQUIRES_PRODUCTION_CHANNEX");
  }
}

function mappingDecisionPrefix(target: AirbnbMappingCanaryTarget): string {
  return `ota-airbnb-autopilot:${target.connectionId}:${target.channelId}:mapping:${target.ratePlanId}:${target.listingId}`;
}

function assertExactQuery(
  query: { organizationId: string; propertyId: string; connectionId: string },
  target: AirbnbMappingCanaryTarget
): void {
  if (
    query.organizationId !== target.organizationId ||
    query.propertyId !== target.propertyId ||
    query.connectionId !== target.connectionId
  ) {
    throw new AirbnbPostAuthCanaryError("CANARY_LOCAL_SCOPE_MISMATCH");
  }
}

export function createCanaryScopedPrismaOwnerStore(
  prisma: PrismaClient,
  target: AirbnbMappingCanaryTarget
): OwnerStore {
  const decisionPrefix = mappingDecisionPrefix(target);

  return {
    async listCallbackEnrollments(limit): Promise<EnrollmentAudit[]> {
      if (limit !== 1) {
        throw new AirbnbPostAuthCanaryError("CANARY_LIMIT_INVALID");
      }
      const audit = await prisma.apmsAuditEntry.findFirst({
        where: {
          organizationId: target.organizationId,
          propertyId: target.propertyId,
          entityType: "DISTRIBUTION",
          entityId: target.connectionId,
          engine: "OTA_AIRBNB_CALLBACK",
          eventType: "CALLBACK_RESOURCE_VERIFIED",
          status: "SUCCESS",
          reason: "CALLBACK_RESOURCE_ONLY",
          AND: [
            { metadata: { path: ["scope"], equals: "CALLBACK_RESOURCE_ONLY" } },
            { metadata: { path: ["channelId"], equals: target.channelId } },
            { metadata: { path: ["activationChanged"], equals: false } },
            { metadata: { path: ["lifecycleStatusChanged"], equals: false } },
          ],
        },
        orderBy: { createdAt: "desc" },
      });
      return audit ? ([audit] as unknown as EnrollmentAudit[]) : [];
    },

    async loadContext(query): Promise<LocalContext | null> {
      assertExactQuery(query, target);
      const row = await prisma.otaChannelConnection.findFirst({
        where: {
          id: target.connectionId,
          organizationId: target.organizationId,
          propertyId: target.propertyId,
          provider: "AIRBNB",
        },
        include: { distributionProperty: { include: { group: true } } },
      });
      if (!row?.distributionProperty || !row.distributionProperty.group) {
        throw new AirbnbPostAuthCanaryError("CANARY_LOCAL_CONTEXT_MISSING");
      }
      const dp = row.distributionProperty;
      const group = dp.group!;
      if (
        row.externalConnectionId !== target.channelId ||
        dp.externalPropertyId !== target.externalPropertyId ||
        group.externalGroupId !== target.externalGroupId ||
        dp.externalPrimaryRatePlanId !== target.ratePlanId
      ) {
        throw new AirbnbPostAuthCanaryError("CANARY_LOCAL_SCOPE_MISMATCH");
      }
      return {
        connectionId: row.id,
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        provider: row.provider,
        status: row.status,
        externalConnectionId: row.externalConnectionId,
        distributionPropertyId: row.distributionPropertyId,
        distributionPlatform: dp.platform,
        distributionProvisioningStatus: dp.provisioningStatus,
        externalPropertyId: dp.externalPropertyId,
        externalPrimaryRatePlanId: dp.externalPrimaryRatePlanId,
        externalGroupId: group.externalGroupId,
        groupPlatform: group.platform,
        groupProvisioningStatus: group.provisioningStatus,
        readinessRevision: row.readinessRevision,
      };
    },

    async findOwnerAudit(decisionId): Promise<OwnerAudit | null> {
      if (!decisionId.startsWith(decisionPrefix)) {
        throw new AirbnbPostAuthCanaryError("CANARY_AUDIT_SCOPE_MISMATCH");
      }
      return (await prisma.apmsAuditEntry.findUnique({
        where: { decisionId },
      })) as unknown as OwnerAudit | null;
    },

    async createOwnerAudit(input): Promise<"CREATED" | "EXISTS"> {
      const decisionId = String(input.decisionId ?? "");
      const eventType = String(input.eventType ?? "");
      if (
        input.organizationId !== target.organizationId ||
        input.propertyId !== target.propertyId ||
        input.entityType !== "DISTRIBUTION" ||
        input.entityId !== target.connectionId ||
        input.engine !== "OTA_DISTRIBUTION_AUTOPILOT" ||
        input.reason !== "CREATE_MAPPING" ||
        !decisionId.startsWith(decisionPrefix) ||
        ![
          "AUTOPILOT_MUTATION_CLAIMED",
          "AUTOPILOT_MUTATION_ACCEPTED",
        ].includes(eventType)
      ) {
        throw new AirbnbPostAuthCanaryError("CANARY_AUDIT_WRITE_NOT_ALLOWED");
      }
      try {
        await prisma.apmsAuditEntry.create({ data: input as any });
        return "CREATED";
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2002"
        ) {
          return "EXISTS";
        }
        throw error;
      }
    },
  };
}

export function createMappingOnlyCanaryProvider(
  provider: Provider,
  target: AirbnbMappingCanaryTarget
): Provider {
  let mutationAttempted = false;

  return {
    async getChannel(channelId) {
      if (channelId !== target.channelId) {
        throw new AirbnbPostAuthCanaryError("CANARY_CHANNEL_SCOPE_MISMATCH");
      }
      const channel = await provider.getChannel(channelId);
      if (
        channel.id !== target.channelId ||
        channel.isActive ||
        channel.groupId !== target.externalGroupId ||
        channel.propertyIds.length !== 1 ||
        channel.propertyIds[0] !== target.externalPropertyId ||
        channel.mappings.length !== 0
      ) {
        throw new AirbnbPostAuthCanaryError("CANARY_PREFLIGHT_STATE_CHANGED");
      }
      return channel;
    },

    async listListings(channelId) {
      if (channelId !== target.channelId) {
        throw new AirbnbPostAuthCanaryError("CANARY_CHANNEL_SCOPE_MISMATCH");
      }
      const listings = await provider.listListings(channelId);
      if (listings.length !== 1 || listings[0]?.id !== target.listingId) {
        throw new AirbnbPostAuthCanaryError("CANARY_LISTING_STATE_CHANGED");
      }
      return listings;
    },

    async createMapping(args) {
      if (
        mutationAttempted ||
        args.channelId !== target.channelId ||
        args.ratePlanId !== target.ratePlanId ||
        args.listingId !== target.listingId
      ) {
        throw new AirbnbPostAuthCanaryError("CANARY_MAPPING_WRITE_NOT_ALLOWED");
      }
      mutationAttempted = true;
      await provider.createMapping(args);
    },

    async checkReadiness() {
      throw new AirbnbPostAuthCanaryError("CANARY_READINESS_NOT_AUTHORIZED");
    },

    async activate() {
      throw new AirbnbPostAuthCanaryError("CANARY_ACTIVATION_NOT_AUTHORIZED");
    },
  };
}

export async function runAirbnbPostAuthMappingCanary(args: {
  target: AirbnbMappingCanaryTarget;
  store: OwnerStore;
  provider: Provider;
  now?: Date;
}) {
  const provider = createMappingOnlyCanaryProvider(args.provider, args.target);
  const result = await runAirbnbPostAuthOwnerCycle({
    store: args.store,
    provider,
    reconcile: async () => {
      throw new AirbnbPostAuthCanaryError("CANARY_RECONCILIATION_NOT_AUTHORIZED");
    },
    limit: 1,
    settleMs: 120_000,
    now: args.now,
  });

  if (
    result.scanned !== 1 ||
    result.providerMutations !== 1 ||
    result.items.length !== 1 ||
    result.items[0]?.outcome !== "WAIT_PROVIDER" ||
    result.items[0]?.reason !== "MAPPING_CREATED"
  ) {
    throw new AirbnbPostAuthCanaryError("CANARY_UNEXPECTED_OUTCOME");
  }

  return {
    outcome: "MAPPING_ACCEPTED_WAIT_PROVIDER" as const,
    channelId: args.target.channelId,
    ratePlanId: args.target.ratePlanId,
    listingId: args.target.listingId,
    providerMutations: 1 as const,
  };
}
