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
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
      !Number.isInteger(settleSeconds) || settleSeconds < 30 || settleSeconds > 1800) {
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
  ) return null;
  const m = record(audit.metadata);
  if (!m || m.scope !== "CALLBACK_RESOURCE_ONLY" ||
      m.activationChanged !== false || m.lifecycleStatusChanged !== false) return null;
  const organizationId = text(audit.organizationId);
  const propertyId = text(audit.propertyId);
  const connectionId = text(audit.entityId);
  const channelId = uuid(m.channelId);
  const requestedByUserId = text(m.requestedByUserId);
  if (!organizationId || !propertyId || !connectionId || !channelId || !requestedByUserId) return null;
  return { decisionId: audit.decisionId, organizationId, propertyId, connectionId, channelId, requestedByUserId };
}

function validateContext(enrollment: Enrollment, context: LocalContext | null) {
  if (!context ||
      context.connectionId !== enrollment.connectionId ||
      context.organizationId !== enrollment.organizationId ||
      context.propertyId !== enrollment.propertyId ||
      context.provider !== "AIRBNB" ||
      context.externalConnectionId !== enrollment.channelId ||
      context.distributionPlatform !== "CHANNEX" ||
      context.distributionProvisioningStatus !== "READY" ||
      context.groupPlatform !== "CHANNEX" ||
      context.groupProvisioningStatus !== "READY" ||
      !Number.isSafeInteger(context.readinessRevision) || context.readinessRevision < 0) return null;
  const externalPropertyId = uuid(context.externalPropertyId);
  const externalGroupId = uuid(context.externalGroupId);
  const ratePlanId = uuid(context.externalPrimaryRatePlanId);
  if (!externalPropertyId || !externalGroupId || !ratePlanId) return null;
  return { externalPropertyId, externalGroupId, ratePlanId };
}

function mutationKey(enrollment: Enrollment, kind: "mapping" | "activate", subject: string) {
  return `ota-airbnb-autopilot:${enrollment.connectionId}:${enrollment.channelId}:${kind}:${subject}`;
}

async function auditOnce(store: OwnerStore, enrollment: Enrollment, now: Date, input: {
  decisionId: string; eventType: string; status: string; severity: string; reason: string; metadata?: Record<string, unknown>;
}) {
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
    if (!enrollment) { items.push({ outcome: "IGNORED", reason: "INVALID_ENROLLMENT" }); continue; }
    const context = await args.store.loadContext(enrollment);
    const local = validateContext(enrollment, context);
    if (!local) {
      await auditOnce(args.store, enrollment, now, {
        decisionId: `ota-airbnb-autopilot:${enrollment.connectionId}:${enrollment.channelId}:action-required:local-context`,
        eventType: "ACTION_REQUIRED", status: "FAILED", severity: "WARNING", reason: "LOCAL_CONTEXT_INVALID",
      });
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "LOCAL_CONTEXT_INVALID" });
      continue;
    }
    if (context!.status === "ACTIVE") {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTIVE", reason: "CANONICAL_ACTIVE" });
      continue;
    }
    if (["DISCONNECTED", "DISCONNECTING"].includes(context!.status)) {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "LOCAL_CHANNEL_DISCONNECTED" });
      continue;
    }

    const channel = await args.provider.getChannel(enrollment.channelId);
    if (channel.id !== enrollment.channelId || channel.groupId !== local.externalGroupId ||
        !channel.propertyIds.includes(local.externalPropertyId)) {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "CHANNEL_SCOPE_MISMATCH" });
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
      items.push({ connectionId: enrollment.connectionId, outcome: "WAIT_CANONICAL", reason: "PROVIDER_ACTIVE" });
      continue;
    }

    const mappings = channel.mappings.filter((m) => m.ratePlanId === local.ratePlanId);
    if (mappings.length > 1) {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "MAPPING_CONFLICT" });
      continue;
    }

    if (mappings.length === 0) {
      const listings = [...new Set((await args.provider.listListings(enrollment.channelId))
        .map((x) => listingId(x.id)).filter((x): x is string => Boolean(x)))];
      if (listings.length !== 1) {
        items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: listings.length ? "MULTIPLE_LISTINGS" : "NO_LISTINGS" });
        continue;
      }
      const subject = `${local.ratePlanId}:${listings[0]}`;
      const acceptedId = `${mutationKey(enrollment, "mapping", subject)}:accepted`;
      if (acceptedFresh(await args.store.findOwnerAudit(acceptedId), now, args.settleMs)) {
        items.push({ connectionId: enrollment.connectionId, outcome: "WAIT_PROVIDER", reason: "MAPPING_SETTLING" });
        continue;
      }
      const claimId = `${mutationKey(enrollment, "mapping", subject)}:claimed`;
      if (await args.store.createOwnerAudit({
        organizationId: enrollment.organizationId, propertyId: enrollment.propertyId,
        entityType: "DISTRIBUTION", entityId: enrollment.connectionId,
        engine: "OTA_DISTRIBUTION_AUTOPILOT", eventType: "AUTOPILOT_MUTATION_CLAIMED",
        status: "IN_PROGRESS", severity: "INFO", decisionId: claimId,
        reason: "CREATE_MAPPING", summary: "Airbnb mapping mutation claimed",
        metadata: { channelId: enrollment.channelId, ratePlanId: local.ratePlanId, listingId: listings[0] },
        startedAt: now, completedAt: null, durationMs: null,
      }) === "EXISTS") {
        items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "MUTATION_OUTCOME_UNCERTAIN" });
        continue;
      }
      try {
        await args.provider.createMapping({ channelId: enrollment.channelId, ratePlanId: local.ratePlanId, listingId: listings[0]! });
        providerMutations++;
        await auditOnce(args.store, enrollment, now, {
          decisionId: acceptedId, eventType: "AUTOPILOT_MUTATION_ACCEPTED", status: "SUCCESS", severity: "INFO",
          reason: "CREATE_MAPPING", metadata: { ratePlanId: local.ratePlanId, listingId: listings[0] },
        });
        items.push({ connectionId: enrollment.connectionId, outcome: "WAIT_PROVIDER", reason: "MAPPING_CREATED" });
      } catch {
        items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "PROVIDER_MUTATION_FAILED" });
      }
      continue;
    }

    const mappedListing = listingId(mappings[0]!.listingId);
    if (!mappedListing) {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "MAPPING_CONFLICT" });
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
      items.push({ connectionId: enrollment.connectionId, outcome: "WAIT_PROVIDER", reason: "READINESS_PENDING" });
      continue;
    }

    const acceptedId = `${mutationKey(enrollment, "activate", "channel")}:accepted`;
    if (acceptedFresh(await args.store.findOwnerAudit(acceptedId), now, args.settleMs)) {
      items.push({ connectionId: enrollment.connectionId, outcome: "WAIT_PROVIDER", reason: "ACTIVATION_SETTLING" });
      continue;
    }
    const claimId = `${mutationKey(enrollment, "activate", "channel")}:claimed`;
    if (await args.store.createOwnerAudit({
      organizationId: enrollment.organizationId, propertyId: enrollment.propertyId,
      entityType: "DISTRIBUTION", entityId: enrollment.connectionId,
      engine: "OTA_DISTRIBUTION_AUTOPILOT", eventType: "AUTOPILOT_MUTATION_CLAIMED",
      status: "IN_PROGRESS", severity: "INFO", decisionId: claimId,
      reason: "ACTIVATE", summary: "Airbnb activation mutation claimed",
      metadata: { channelId: enrollment.channelId }, startedAt: now, completedAt: null, durationMs: null,
    }) === "EXISTS") {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "MUTATION_OUTCOME_UNCERTAIN" });
      continue;
    }
    try {
      await args.provider.activate(enrollment.channelId);
      providerMutations++;
      await auditOnce(args.store, enrollment, now, {
        decisionId: acceptedId, eventType: "AUTOPILOT_MUTATION_ACCEPTED", status: "SUCCESS", severity: "INFO", reason: "ACTIVATE",
      });
      items.push({ connectionId: enrollment.connectionId, outcome: "WAIT_PROVIDER", reason: "ACTIVATION_REQUESTED" });
    } catch {
      items.push({ connectionId: enrollment.connectionId, outcome: "ACTION_REQUIRED", reason: "PROVIDER_MUTATION_FAILED" });
    }
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
          status: { in: ["NOT_CONNECTED", "AUTHORIZATION_REQUIRED", "MAPPING_REQUIRED", "READINESS_CHECK", "ACTIVATION_PENDING", "DEGRADED", "FAILED"] },
        },
        orderBy: { updatedAt: "asc" }, take: Math.min(limit * 4, 100),
        select: { id: true, organizationId: true, propertyId: true, externalConnectionId: true },
      });
      const out: EnrollmentAudit[] = [];
      for (const c of connections) {
        if (out.length >= limit) break;
        const audit = await prisma.apmsAuditEntry.findFirst({
          where: {
            organizationId: c.organizationId, propertyId: c.propertyId,
            entityType: "DISTRIBUTION", entityId: c.id,
            engine: "OTA_AIRBNB_CALLBACK", eventType: "CALLBACK_RESOURCE_VERIFIED",
            status: "SUCCESS", reason: "CALLBACK_RESOURCE_ONLY",
            AND: [
              { metadata: { path: ["scope"], equals: "CALLBACK_RESOURCE_ONLY" } },
              { metadata: { path: ["channelId"], equals: c.externalConnectionId } },
              { metadata: { path: ["activationChanged"], equals: false } },
              { metadata: { path: ["lifecycleStatusChanged"], equals: false } },
            ],
          }, orderBy: { createdAt: "desc" },
        });
        if (audit) out.push(audit);
      }
      return out;
    },
    async loadContext(q) {
      const row = await prisma.otaChannelConnection.findFirst({
        where: { id: q.connectionId, organizationId: q.organizationId, propertyId: q.propertyId, provider: "AIRBNB" },
        include: { distributionProperty: { include: { group: true } } },
      });
      if (!row?.distributionProperty) return null;
      const dp = row.distributionProperty;
      return {
        connectionId: row.id, organizationId: row.organizationId, propertyId: row.propertyId,
        provider: row.provider, status: row.status, externalConnectionId: row.externalConnectionId,
        distributionPropertyId: row.distributionPropertyId, distributionPlatform: dp.platform,
        distributionProvisioningStatus: dp.provisioningStatus, externalPropertyId: dp.externalPropertyId,
        externalPrimaryRatePlanId: dp.externalPrimaryRatePlanId, externalGroupId: dp.group?.externalGroupId ?? null,
        groupPlatform: dp.group?.platform ?? null, groupProvisioningStatus: dp.group?.provisioningStatus ?? null,
        readinessRevision: row.readinessRevision,
      };
    },
    findOwnerAudit(decisionId) { return prisma.apmsAuditEntry.findUnique({ where: { decisionId } }); },
    async createOwnerAudit(input) {
      try { await prisma.apmsAuditEntry.create({ data: input }); return "CREATED"; }
      catch (e) { if (e && typeof e === "object" && "code" in e && (e as any).code === "P2002") return "EXISTS"; throw e; }
    },
  };
}

export function createChannexAirbnbPostAuthProvider(args: {
  apiOrigin: string; apiKey: string; fetchImpl?: typeof fetch;
}): Provider {
  let origin: string;
  try {
    const u = new URL(String(args.apiOrigin ?? "").trim());
    if (!ALLOWED_ORIGINS.has(u.origin) || u.href.replace(/\/$/, "") !== u.origin) throw new Error();
    origin = u.origin;
  } catch { throw new Error("OTA_AIRBNB_AUTOPILOT_PROVIDER_ORIGIN_INVALID"); }
  const apiKey = String(args.apiKey ?? "").trim();
  if (!apiKey || apiKey.length > 4096) throw new Error("OTA_AIRBNB_AUTOPILOT_API_KEY_INVALID");
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await (args.fetchImpl ?? fetch)(`${origin}/api/v1${path}`, {
      method, redirect: "error",
      headers: { Accept: "application/json", "user-api-key": apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`OTA_AIRBNB_AUTOPILOT_PROVIDER_REQUEST_FAILED:${res.status}`);
    return payload as any;
  };
  return {
    async getChannel(channelId) {
      const id = uuid(channelId); if (!id) throw new Error("INVALID_CHANNEL_ID");
      const p = await request("GET", `/channels/${encodeURIComponent(id)}`);
      const d = record(p?.data); const a = record(d?.attributes); const r = record(d?.relationships);
      if (!d || !a || !r || d.type !== "channel" || uuid(d.id) !== id || !["Airbnb", "AirBNB"].includes(String(a.channel)) || typeof a.is_active !== "boolean") throw new Error("INVALID_CHANNEL_RESPONSE");
      const props = record(r.properties)?.data; const group = record(record(r.group)?.data);
      if (!Array.isArray(props) || !group || group.type !== "group" || !uuid(group.id) || !Array.isArray(a.rate_plans)) throw new Error("INVALID_CHANNEL_SCOPE");
      return {
        id, propertyIds: props.map((x: any) => uuid(record(x)?.id)).filter((x: any): x is string => Boolean(x)), groupId: uuid(group.id)!, isActive: a.is_active,
        mappings: a.rate_plans.map((x: any) => ({ id: uuid(record(x)?.id)!, ratePlanId: uuid(record(x)?.rate_plan_id)!, listingId: listingId(record(record(x)?.settings)?.listing_id) })),
      };
    },
    async listListings(channelId) {
      const id = uuid(channelId); if (!id) throw new Error("INVALID_CHANNEL_ID");
      const p = await request("GET", `/channels/${encodeURIComponent(id)}/action/listings`);
      const values = record(record(p?.data)?.listing_id_dictionary)?.values;
      if (!Array.isArray(values)) throw new Error("INVALID_LISTINGS_RESPONSE");
      return values.map((x: any) => ({ id: listingId(record(x)?.id)!, title: typeof record(x)?.title === "string" ? String(record(x)?.title) : null }));
    },
    async createMapping({ channelId, ratePlanId, listingId: lid }) {
      const id = uuid(channelId), rate = uuid(ratePlanId), listing = listingId(lid);
      if (!id || !rate || !listing) throw new Error("INVALID_MAPPING_INPUT");
      const p = await request("POST", `/channels/${encodeURIComponent(id)}/mappings`, { mapping: { rate_plan_id: rate, settings: { listing_id: listing } } });
      if (record(p?.data)?.type !== "channel_rate_plan") throw new Error("INVALID_MAPPING_RESPONSE");
    },
    async checkReadiness(channelId) {
      const id = uuid(channelId); if (!id) throw new Error("INVALID_CHANNEL_ID");
      const p = await request("POST", `/channels/${encodeURIComponent(id)}/check_readiness`);
      if (!Array.isArray(p?.data) || !record(p?.meta)) throw new Error("INVALID_READINESS_RESPONSE");
      return { issues: p.data.map((x: any) => `${x.entity}:${x.relation}:${x.error_code}`) };
    },
    async activate(channelId) {
      const id = uuid(channelId); if (!id) throw new Error("INVALID_CHANNEL_ID");
      const p = await request("POST", `/channels/${encodeURIComponent(id)}/activate`);
      if (typeof record(p?.meta)?.message !== "string") throw new Error("INVALID_ACTIVATE_RESPONSE");
    },
  };
}

export async function runAirbnbPostAuthOwnerOnce(args: {
  env: Readonly<Record<string, string | undefined>>;
  store: OwnerStore; provider: Provider; reconcile: Reconciler; now?: Date;
}) {
  const runtime = resolveAirbnbPostAuthRuntime(args.env);
  if (!runtime.enabled) return { skipped: true as const, reason: runtime.reason };
  return { skipped: false as const, result: await runAirbnbPostAuthOwnerCycle({
    store: args.store, provider: args.provider, reconcile: args.reconcile,
    limit: runtime.batchSize, settleMs: runtime.settleMs, now: args.now,
  }) };
}
