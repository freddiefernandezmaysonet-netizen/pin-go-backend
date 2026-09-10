const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LISTING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const ALLOWED_ORIGINS = new Set(["https://app.channex.io", "https://staging.channex.io"]);

export const AIRBNB_POST_AUTH_AUTOPILOT_FLAG =
  "OTA_AIRBNB_POST_AUTH_AUTOPILOT_ENABLED" as const;

export type Runtime =
  | { enabled: false; reason: "DEFAULT_OFF" | "INVALID_CONFIGURATION" }
  | { enabled: true; reason: "ENABLED"; batchSize: number; settleMs: number };

export type LocalContext = {
  connectionId: string;
  organizationId: string;
  propertyId: string;
  provider: string;
  status: string;
  externalConnectionId: string | null;
  distributionPropertyId: string;
  distributionPlatform: string;
  distributionProvisioningStatus: string;
  externalPropertyId: string | null;
  externalPrimaryRatePlanId: string | null;
  externalGroupId: string | null;
  groupPlatform: string | null;
  groupProvisioningStatus: string | null;
  readinessRevision: number;
};

export type EnrollmentAudit = {
  organizationId: string | null;
  propertyId: string | null;
  entityType: string;
  entityId: string;
  engine: string;
  eventType: string | null;
  status: string;
  decisionId: string;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
};

export type OwnerAudit = {
  decisionId: string;
  status: string;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
};

export type OwnerStore = {
  listCallbackEnrollments(limit: number): Promise<EnrollmentAudit[]>;
  loadContext(args: {
    organizationId: string;
    propertyId: string;
    connectionId: string;
  }): Promise<LocalContext | null>;
  findOwnerAudit(decisionId: string): Promise<OwnerAudit | null>;
  createOwnerAudit(input: Record<string, unknown>): Promise<"CREATED" | "EXISTS">;
};

export type ProviderChannel = {
  id: string;
  propertyIds: string[];
  groupId: string;
  isActive: boolean;
  mappings: Array<{ id: string; ratePlanId: string; listingId: string | null }>;
};

export type Provider = {
  getChannel(channelId: string): Promise<ProviderChannel>;
  listListings(channelId: string): Promise<Array<{ id: string; title: string | null }>>;
  createMapping(args: { channelId: string; ratePlanId: string; listingId: string }): Promise<void>;
  checkReadiness(channelId: string): Promise<{ issues: string[] }>;
  activate(channelId: string): Promise<void>;
};

export type Reconciler = (args: {
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  provider: "AIRBNB";
  requestKey: string;
}) => Promise<unknown>;

type Enrollment = {
  decisionId: string;
  organizationId: string;
  propertyId: string;
  connectionId: string;
  channelId: string;
  requestedByUserId: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  const out = typeof value === "string" ? value.trim() : "";
  return out ? out : null;
}

function uuid(value: unknown): string | null {
  const out = text(value);
  return out && UUID.test(out) ? out : null;
}

function listingId(value: unknown): string | null {
  const out = text(value);
  return out && LISTING_ID.test(out) ? out : null;
}

export function resolveAirbnbPostAuthRuntime(
  env: Readonly<Record<string, string | undefined>>
): Runtime {
  const raw = String(env[AIRBNB_POST_AUTH_AUTOPILOT_FLAG] ?? "").trim();
  if (!raw) return { enabled: false, reason: "DEFAULT_OFF" };
  if (raw !== "true") return { enabled: false, reason: "INVALID_CONFIGURATION" };
  const batchRaw = String(env.OTA_AIRBNB_POST_AUTH_AUTOPILOT_BATCH_SIZE ?? "25").trim();
  const settleRaw = String(env.OTA_AIRBNB_POST_AUTH_AUTOPILOT_SETTLE_SECONDS ?? "120").trim();
  if (!/^\d+$/.test(batchRaw) || !/^\d+$/.test(settleRaw)) {
    return { enabled: false, reason: "INVALID_CONFIGURATION" };
  }
  const batchSize = Number(batchRaw);
  const settleSeconds = Number(settleRaw);
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isInteger(settleSeconds) ||
    settleSeconds < 30 ||
    settleSeconds > 1800
  ) {
    return { enabled: false, reason: "INVALID_CONFIGURATION" };
  }
  return { enabled: true, reason: "ENABLED", batchSize, settleMs: settleSeconds * 1000 };
}

export function parseEnrollment(audit: EnrollmentAudit): Enrollment | null {
  if (
    audit.entityType !== "DISTRIBUTION" ||
    audit.engine !== "OTA_AIRBNB_CALLBACK" ||
    audit.eventType !== "CALLBACK_RESOURCE_VERIFIED" ||
    audit.status !== "SUCCESS" ||
    audit.reason !== "CALLBACK_RESOURCE_ONLY" ||
    !(audit.createdAt instanceof Date) ||
    !Number.isFinite(audit.createdAt.getTime())
  ) {
    return null;
  }
  const m = record(audit.metadata);
  if (
    !m ||
    m.scope !== "CALLBACK_RESOURCE_ONLY" ||
    m.activationChanged !== false ||
    m.lifecycleStatusChanged !== false
  ) {
    return null;
  }
  const organizationId = text(audit.organizationId);
  const propertyId = text(audit.propertyId);
  const connectionId = text(audit.entityId);
  const channelId = uuid(m.channelId);
  const requestedByUserId = text(m.requestedByUserId);
  if (!organizationId || !propertyId || !connectionId || !channelId || !requestedByUserId) {
    return null;
  }
  return {
    decisionId: audit.decisionId,
    organizationId,
    propertyId,
    connectionId,
    channelId,
    requestedByUserId,
  };
}

function validateContext(enrollment: Enrollment, context: LocalContext | null) {
  if (
    !context ||
    context.connectionId !== enrollment.connectionId ||
    context.organizationId !== enrollment.organizationId ||
    context.propertyId !== enrollment.propertyId ||
    context.provider !== "AIRBNB" ||
    context.externalConnectionId !== enrollment.channelId ||
    context.distributionPlatform !== "CHANNEX" ||
    context.distributionProvisioningStatus !== "READY" ||
    context.groupPlatform !== "CHANNEX" ||
    context.groupProvisioningStatus !== "READY" ||
    !Number.isSafeInteger(context.readinessRevision) ||
    context.readinessRevision < 0
  ) {
    return null;
  }
  const externalPropertyId = uuid(context.externalPropertyId);
  const externalGroupId = uuid(context.externalGroupId);
  const ratePlanId = uuid(context.externalPrimaryRatePlanId);
  if (!externalPropertyId || !externalGroupId || !ratePlanId) return null;
  return { externalPropertyId, externalGroupId, ratePlanId };
}

function mutationKey(
  enrollment: Enrollment,
  kind: "mapping" | "activate",
  subject: string
) {
  return `ota-airbnb-autopilot:${enrollment.connectionId}:${enrollment.channelId}:${kind}:${subject}`;
}

async function auditOnce(
  store: OwnerStore,
  enrollment: Enrollment,
  now: Date,
  input: {
    decisionId: string;
    eventType: string;
    status: string;
    severity: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }
) {
  return store.createOwnerAudit({
    organizationId: enrollment.organizationId,
    propertyId: enrollment.propertyId,
    entityType: "DISTRIBUTION",
    entityId: enrollment.connectionId,
    engine: "OTA_DISTRIBUTION_AUTOPILOT",
    eventType: input.eventType,
    status: input.status,
    severity: input.severity,
    decisionId: input.decisionId,
    reason: input.reason,
    summary: "Airbnb post-authorization autopilot",
    metadata: {
      ownerVersion: "airbnb_post_authorization_owner_v1",
      enrollmentDecisionId: enrollment.decisionId,
      channelId: enrollment.channelId,
      requestedByUserId: enrollment.requestedByUserId,
      ...(input.metadata ?? {}),
    },
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  });
}

function acceptedFresh(audit: OwnerAudit | null, now: Date, settleMs: number) {
  if (!audit || audit.status !== "SUCCESS") return false;
  return now.getTime() - audit.createdAt.getTime() < settleMs;
}

export async function runAirbnbPostAuthOwnerCycle(args: {
  store: OwnerStore;
  provider: Provider;
  reconcile: Reconciler;
  limit: number;
  settleMs: number;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const audits = await args.store.listCallbackEnrollments(args.limit);
  const items: Array<Record<string, unknown>> = [];
  let providerMutations = 0;

  for (const raw of audits) {
    const enrollment = parseEnrollment(raw);
    if (!enrollment) {
      items.push({ outcome: "IGNORED", reason: "INVALID_ENROLLMENT" });
      continue;
    }

    const context = await args.store.loadContext(enrollment);
    const local = validateContext(enrollment, context);
    if (!local) {
      await auditOnce(args.store, enrollment, now, {
        decisionId: `ota-airbnb-autopilot:${enrollment.connectionId}:${enrollment.channelId}:action-required:local-context`,
        eventType: "ACTION_REQUIRED",
        status: "FAILED",
        severity: "WARNING",
        reason: "LOCAL_CONTEXT_INVALID",
      });
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "LOCAL_CONTEXT_INVALID",
      });
      continue;
    }

    if (context!.status === "ACTIVE") {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTIVE",
        reason: "CANONICAL_ACTIVE",
      });
      continue;
    }

    if (["DISCONNECTED", "DISCONNECTING"].includes(context!.status)) {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "LOCAL_CHANNEL_DISCONNECTED",
      });
      continue;
    }

    const channel = await args.provider.getChannel(enrollment.channelId);
    if (
      channel.id !== enrollment.channelId ||
      channel.groupId !== local.externalGroupId ||
      !channel.propertyIds.includes(local.externalPropertyId)
    ) {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "CHANNEL_SCOPE_MISMATCH",
      });
      continue;
    }

    if (channel.isActive) {
      await args.reconcile({
        organizationId: enrollment.organizationId,
        propertyId: enrollment.propertyId,
        requestedByUserId: enrollment.requestedByUserId,
        provider: "AIRBNB",
        requestKey: `airbnb-post-auth:${enrollment.connectionId}:r${context!.readinessRevision}`,
      });
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "WAIT_CANONICAL",
        reason: "PROVIDER_ACTIVE",
      });
      continue;
    }

    const mappings = channel.mappings.filter(
      (mapping) => mapping.ratePlanId === local.ratePlanId
    );
    if (mappings.length > 1) {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "MAPPING_CONFLICT",
      });
      continue;
    }

    if (mappings.length === 0) {
      const listings = [
        ...new Set(
          (await args.provider.listListings(enrollment.channelId))
            .map((item) => listingId(item.id))
            .filter((item): item is string => Boolean(item))
        ),
      ];
      if (listings.length !== 1) {
        items.push({
          connectionId: enrollment.connectionId,
          outcome: "ACTION_REQUIRED",
          reason: listings.length ? "MULTIPLE_LISTINGS" : "NO_LISTINGS",
        });
        continue;
      }

      const subject = `${local.ratePlanId}:${listings[0]}`;
      const acceptedId = `${mutationKey(enrollment, "mapping", subject)}:accepted`;
      if (
        acceptedFresh(
          await args.store.findOwnerAudit(acceptedId),
          now,
          args.settleMs
        )
      ) {
        items.push({
          connectionId: enrollment.connectionId,
          outcome: "WAIT_PROVIDER",
          reason: "MAPPING_SETTLING",
        });
        continue;
      }

      const claimId = `${mutationKey(enrollment, "mapping", subject)}:claimed`;
      if (
        (await args.store.createOwnerAudit({
          organizationId: enrollment.organizationId,
          propertyId: enrollment.propertyId,
          entityType: "DISTRIBUTION",
          entityId: enrollment.connectionId,
          engine: "OTA_DISTRIBUTION_AUTOPILOT",
          eventType: "AUTOPILOT_MUTATION_CLAIMED",
          status: "IN_PROGRESS",
          severity: "INFO",
          decisionId: claimId,
          reason: "CREATE_MAPPING",
          summary: "Airbnb mapping mutation claimed",
          metadata: {
            channelId: enrollment.channelId,
            ratePlanId: local.ratePlanId,
            listingId: listings[0],
          },
          startedAt: now,
          completedAt: null,
          durationMs: null,
        })) === "EXISTS"
      ) {
        items.push({
          connectionId: enrollment.connectionId,
          outcome: "ACTION_REQUIRED",
          reason: "MUTATION_OUTCOME_UNCERTAIN",
        });
        continue;
      }

      try {
        await args.provider.createMapping({
          channelId: enrollment.channelId,
          ratePlanId: local.ratePlanId,
          listingId: listings[0]!,
        });
        providerMutations++;
        await auditOnce(args.store, enrollment, now, {
          decisionId: acceptedId,
          eventType: "AUTOPILOT_MUTATION_ACCEPTED",
          status: "SUCCESS",
          severity: "INFO",
          reason: "CREATE_MAPPING",
          metadata: {
            ratePlanId: local.ratePlanId,
            listingId: listings[0],
          },
        });
        items.push({
          connectionId: enrollment.connectionId,
          outcome: "WAIT_PROVIDER",
          reason: "MAPPING_CREATED",
        });
      } catch {
        items.push({
          connectionId: enrollment.connectionId,
          outcome: "ACTION_REQUIRED",
          reason: "PROVIDER_MUTATION_FAILED",
        });
      }

      // Global provider-write budget: once a write has been attempted, stop this
      // cycle even when the provider response is uncertain or failed. A later
      // cycle must re-observe Channex before deciding whether another write is safe.
      break;
    }

    const mappedListing = listingId(mappings[0]!.listingId);
    if (!mappedListing) {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "MAPPING_CONFLICT",
      });
      continue;
    }

    const readiness = await args.provider.checkReadiness(enrollment.channelId);
    if (readiness.issues.length) {
      await args.reconcile({
        organizationId: enrollment.organizationId,
        propertyId: enrollment.propertyId,
        requestedByUserId: enrollment.requestedByUserId,
        provider: "AIRBNB",
        requestKey: `airbnb-post-auth:${enrollment.connectionId}:r${context!.readinessRevision}`,
      });
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "WAIT_PROVIDER",
        reason: "READINESS_PENDING",
      });
      continue;
    }

    const acceptedId = `${mutationKey(enrollment, "activate", "channel")}:accepted`;
    if (
      acceptedFresh(
        await args.store.findOwnerAudit(acceptedId),
        now,
        args.settleMs
      )
    ) {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "WAIT_PROVIDER",
        reason: "ACTIVATION_SETTLING",
      });
      continue;
    }

    const claimId = `${mutationKey(enrollment, "activate", "channel")}:claimed`;
    if (
      (await args.store.createOwnerAudit({
        organizationId: enrollment.organizationId,
        propertyId: enrollment.propertyId,
        entityType: "DISTRIBUTION",
        entityId: enrollment.connectionId,
        engine: "OTA_DISTRIBUTION_AUTOPILOT",
        eventType: "AUTOPILOT_MUTATION_CLAIMED",
        status: "IN_PROGRESS",
        severity: "INFO",
        decisionId: claimId,
        reason: "ACTIVATE",
        summary: "Airbnb activation mutation claimed",
        metadata: { channelId: enrollment.channelId },
        startedAt: now,
        completedAt: null,
        durationMs: null,
      })) === "EXISTS"
    ) {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "MUTATION_OUTCOME_UNCERTAIN",
      });
      continue;
    }

    try {
      await args.provider.activate(enrollment.channelId);
      providerMutations++;
      await auditOnce(args.store, enrollment, now, {
        decisionId: acceptedId,
        eventType: "AUTOPILOT_MUTATION_ACCEPTED",
        status: "SUCCESS",
        severity: "INFO",
        reason: "ACTIVATE",
      });
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "WAIT_PROVIDER",
        reason: "ACTIVATION_REQUESTED",
      });
    } catch {
      items.push({
        connectionId: enrollment.connectionId,
        outcome: "ACTION_REQUIRED",
        reason: "PROVIDER_MUTATION_FAILED",
      });
    }

    // Same global write-attempt budget as mapping above.
    break;
  }

  return { scanned: audits.length, providerMutations, items };
}

export function createPrismaOwnerStore(prisma: any): OwnerStore {
  return {
    async listCallbackEnrollments(limit) {
      const connections = await prisma.otaChannelConnection.findMany({
        where: {
          provider: "AIRBNB",
          externalConnectionId: { not: null },
          status: {
            in: [
              "NOT_CONNECTED",
              "AUTHORIZATION_REQUIRED",
              "MAPPING_REQUIRED",
              "READINESS_CHECK",
              "ACTIVATION_PENDING",
              "DEGRADED",
              "FAILED",
            ],
          },
        },
        orderBy: { updatedAt: "asc" },
        take: Math.min(limit * 4, 100),
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          externalConnectionId: true,
        },
      });
      const out: EnrollmentAudit[] = [];
      for (const connection of connections) {
        if (out.length >= limit) break;
        const audit = await prisma.apmsAuditEntry.findFirst({
          where: {
            organizationId: connection.organizationId,
            propertyId: connection.propertyId,
            entityType: "DISTRIBUTION",
            entityId: connection.id,
            engine: "OTA_AIRBNB_CALLBACK",
            eventType: "CALLBACK_RESOURCE_VERIFIED",
            status: "SUCCESS",
            reason: "CALLBACK_RESOURCE_ONLY",
            AND: [
              {
                metadata: {
                  path: ["scope"],
                  equals: "CALLBACK_RESOURCE_ONLY",
                },
              },
              {
                metadata: {
                  path: ["channelId"],
                  equals: connection.externalConnectionId,
                },
              },
              {
                metadata: {
                  path: ["activationChanged"],
                  equals: false,
                },
              },
              {
                metadata: {
                  path: ["lifecycleStatusChanged"],
                  equals: false,
                },
              },
            ],
          },
          orderBy: { createdAt: "desc" },
        });
        if (audit) out.push(audit);
      }
      return out;
    },

    async loadContext(query) {
      const row = await prisma.otaChannelConnection.findFirst({
        where: {
          id: query.connectionId,
          organizationId: query.organizationId,
          propertyId: query.propertyId,
          provider: "AIRBNB",
        },
        include: {
          distributionProperty: { include: { group: true } },
        },
      });
      if (!row?.distributionProperty) return null;
      const distributionProperty = row.distributionProperty;
      return {
        connectionId: row.id,
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        provider: row.provider,
        status: row.status,
        externalConnectionId: row.externalConnectionId,
        distributionPropertyId: row.distributionPropertyId,
        distributionPlatform: distributionProperty.platform,
        distributionProvisioningStatus: distributionProperty.provisioningStatus,
        externalPropertyId: distributionProperty.externalPropertyId,
        externalPrimaryRatePlanId: distributionProperty.externalPrimaryRatePlanId,
        externalGroupId: distributionProperty.group?.externalGroupId ?? null,
        groupPlatform: distributionProperty.group?.platform ?? null,
        groupProvisioningStatus:
          distributionProperty.group?.provisioningStatus ?? null,
        readinessRevision: row.readinessRevision,
      };
    },

    findOwnerAudit(decisionId) {
      return prisma.apmsAuditEntry.findUnique({ where: { decisionId } });
    },

    async createOwnerAudit(input) {
      try {
        await prisma.apmsAuditEntry.create({ data: input });
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

function parseChannelPropertyIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("INVALID_CHANNEL_SCOPE");
  const propertyIds = value.map((item) => {
    const property = record(item);
    const id = property ? uuid(property.id) : null;
    if (!property || property.type !== "property" || !id) {
      throw new Error("INVALID_CHANNEL_SCOPE");
    }
    return id;
  });
  if (new Set(propertyIds).size !== propertyIds.length) {
    throw new Error("INVALID_CHANNEL_SCOPE");
  }
  return propertyIds;
}

function parseChannelMappings(value: unknown): ProviderChannel["mappings"] {
  if (!Array.isArray(value)) throw new Error("INVALID_CHANNEL_RESPONSE");
  const mappings = value.map((item) => {
    const mapping = record(item);
    const id = mapping ? uuid(mapping.id) : null;
    const ratePlanId = mapping ? uuid(mapping.rate_plan_id) : null;
    const settings = mapping ? record(mapping.settings) : null;
    if (!mapping || !id || !ratePlanId || !settings) {
      throw new Error("INVALID_CHANNEL_RESPONSE");
    }
    const rawListingId = settings.listing_id;
    const parsedListingId =
      rawListingId === null || rawListingId === undefined
        ? null
        : listingId(rawListingId);
    if (
      rawListingId !== null &&
      rawListingId !== undefined &&
      parsedListingId === null
    ) {
      throw new Error("INVALID_CHANNEL_RESPONSE");
    }
    return { id, ratePlanId, listingId: parsedListingId };
  });
  if (new Set(mappings.map((mapping) => mapping.id)).size !== mappings.length) {
    throw new Error("INVALID_CHANNEL_RESPONSE");
  }
  return mappings;
}

export function createChannexAirbnbPostAuthProvider(args: {
  apiOrigin: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Provider {
  let origin: string;
  try {
    const url = new URL(String(args.apiOrigin ?? "").trim());
    if (
      !ALLOWED_ORIGINS.has(url.origin) ||
      url.href.replace(/\/$/, "") !== url.origin
    ) {
      throw new Error();
    }
    origin = url.origin;
  } catch {
    throw new Error("OTA_AIRBNB_AUTOPILOT_PROVIDER_ORIGIN_INVALID");
  }

  const apiKey = String(args.apiKey ?? "").trim();
  if (!apiKey || apiKey.length > 4096) {
    throw new Error("OTA_AIRBNB_AUTOPILOT_API_KEY_INVALID");
  }

  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ) => {
    const response = await (args.fetchImpl ?? fetch)(`${origin}/api/v1${path}`, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "user-api-key": apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        `OTA_AIRBNB_AUTOPILOT_PROVIDER_REQUEST_FAILED:${response.status}`
      );
    }
    return payload as any;
  };

  return {
    async getChannel(channelId) {
      const id = uuid(channelId);
      if (!id) throw new Error("INVALID_CHANNEL_ID");
      const payload = await request(
        "GET",
        `/channels/${encodeURIComponent(id)}`
      );
      const data = record(payload?.data);
      const attributes = record(data?.attributes);
      const relationships = record(data?.relationships);
      if (
        !data ||
        !attributes ||
        !relationships ||
        data.type !== "channel" ||
        uuid(data.id) !== id ||
        !["Airbnb", "AirBNB"].includes(String(attributes.channel)) ||
        typeof attributes.is_active !== "boolean"
      ) {
        throw new Error("INVALID_CHANNEL_RESPONSE");
      }

      const group = record(record(relationships.group)?.data);
      const groupId = group ? uuid(group.id) : null;
      if (!group || group.type !== "group" || !groupId) {
        throw new Error("INVALID_CHANNEL_SCOPE");
      }

      // Fail closed: malformed property/mapping identities invalidate the entire
      // resource. Never silently filter malformed UUIDs and continue onboarding.
      const propertyIds = parseChannelPropertyIds(
        record(relationships.properties)?.data
      );
      const mappings = parseChannelMappings(attributes.rate_plans);

      return {
        id,
        propertyIds,
        groupId,
        isActive: attributes.is_active,
        mappings,
      };
    },

    async listListings(channelId) {
      const id = uuid(channelId);
      if (!id) throw new Error("INVALID_CHANNEL_ID");
      const payload = await request(
        "GET",
        `/channels/${encodeURIComponent(id)}/action/listings`
      );
      const values = record(
        record(payload?.data)?.listing_id_dictionary
      )?.values;
      if (!Array.isArray(values)) {
        throw new Error("INVALID_LISTINGS_RESPONSE");
      }
      return values.map((item) => ({
        id: listingId(record(item)?.id)!,
        title:
          typeof record(item)?.title === "string"
            ? String(record(item)?.title)
            : null,
      }));
    },

    async createMapping({ channelId, ratePlanId, listingId: rawListingId }) {
      const id = uuid(channelId);
      const rate = uuid(ratePlanId);
      const listing = listingId(rawListingId);
      if (!id || !rate || !listing) throw new Error("INVALID_MAPPING_INPUT");
      const payload = await request(
        "POST",
        `/channels/${encodeURIComponent(id)}/mappings`,
        {
          mapping: {
            rate_plan_id: rate,
            settings: { listing_id: listing },
          },
        }
      );
      if (record(payload?.data)?.type !== "channel_rate_plan") {
        throw new Error("INVALID_MAPPING_RESPONSE");
      }
    },

    async checkReadiness(channelId) {
      const id = uuid(channelId);
      if (!id) throw new Error("INVALID_CHANNEL_ID");
      const payload = await request(
        "POST",
        `/channels/${encodeURIComponent(id)}/check_readiness`
      );
      if (!Array.isArray(payload?.data) || !record(payload?.meta)) {
        throw new Error("INVALID_READINESS_RESPONSE");
      }
      return {
        issues: payload.data.map(
          (item: any) => `${item.entity}:${item.relation}:${item.error_code}`
        ),
      };
    },

    async activate(channelId) {
      const id = uuid(channelId);
      if (!id) throw new Error("INVALID_CHANNEL_ID");
      const payload = await request(
        "POST",
        `/channels/${encodeURIComponent(id)}/activate`
      );
      if (typeof record(payload?.meta)?.message !== "string") {
        throw new Error("INVALID_ACTIVATE_RESPONSE");
      }
    },
  };
}

export async function runAirbnbPostAuthOwnerOnce(args: {
  env: Readonly<Record<string, string | undefined>>;
  store: OwnerStore;
  provider: Provider;
  reconcile: Reconciler;
  now?: Date;
}) {
  const runtime = resolveAirbnbPostAuthRuntime(args.env);
  if (!runtime.enabled) {
    return { skipped: true as const, reason: runtime.reason };
  }
  return {
    skipped: false as const,
    result: await runAirbnbPostAuthOwnerCycle({
      store: args.store,
      provider: args.provider,
      reconcile: args.reconcile,
      limit: runtime.batchSize,
      settleMs: runtime.settleMs,
      now: args.now,
    }),
  };
}
