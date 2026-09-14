import assert from "node:assert/strict";
import test from "node:test";
import { buildOtaConnectionCenterComposition } from "./ota-connection-center.composition.js";
import { resolveChannexAriMapping } from "../pms/outbound/channex-ari-mapping.service.js";
import { assertFullSyncCanonicalMappingConsistency } from "../routes/dashboard.channex-full-sync.route.js";

import {
  OtaProvisioningRepositoryError,
  PrismaOtaProvisioningRepository,
} from "./ota-provisioning.repository.js";

function setup(record?: any, pmsListings: any[] = []) {
  const reads: any[] = [];
  const groupUpdates: any[] = [];
  const propertyUpdates: any[] = [];
  const pmsUpdates: any[] = [];
  const audits: any[] = [];
  const client = {
    distributionProperty: {
      async findFirst(args: any) { reads.push(args); return record ?? null; },
      async updateMany(args: any) { propertyUpdates.push(args); return { count: 1 }; },
    },
    distributionGroup: {
      async updateMany(args: any) { groupUpdates.push(args); return { count: 1 }; },
    },
    pmsListing: {
      async findMany() { return pmsListings; },
      async findUnique() { throw new Error("Unexpected listing lookup during alignment"); },
      async create() { throw new Error("Unexpected listing creation during alignment"); },
      async updateMany(args: any) { pmsUpdates.push(args); return { count: 1 }; },
    },
    pmsConnection: {
      async findUnique() { throw new Error("Unexpected connection lookup during alignment"); },
      async create() { throw new Error("Unexpected connection creation during alignment"); },
    },
    apmsAuditEntry: {
      async create(args: any) { audits.push(args); return { id: "audit-1" }; },
    },
    async $transaction<T>(work: (tx: any) => Promise<T>) { return work(client); },
  };
  return {
    repository: new PrismaOtaProvisioningRepository(client, "usd"),
    reads,
    groupUpdates,
    propertyUpdates,
    pmsUpdates,
    audits,
  };
}

const record = {
  id: "distribution-property-1",
  organizationId: "org-1",
  propertyId: "property-1",
  platform: "CHANNEX",
  provisioningStatus: "FAILED",
  lastErrorCode: "OTA_PROVIDER_REJECTED",
  externalPropertyId: "property-ext",
  externalPrimaryRoomTypeId: "room-ext",
  externalPrimaryRatePlanId: null,
  organization: { name: "Organization One" },
  updatedAt: new Date("2026-09-12T12:00:00.000Z"),
  property: {
    id: "property-1",
    organizationId: "org-1",
    name: "Casa Uno",
    timezone: "America/Puerto_Rico",
  },
  group: {
    id: "group-1",
    organizationId: "org-1",
    platform: "CHANNEX",
    provisioningStatus: "READY",
    lastErrorCode: null,
    externalGroupId: "group-ext",
  },
};

const legacyListing = {
  id: "listing-1",
  connectionId: "pms-connection-1",
  propertyId: "property-1",
  externalListingId: "certified-room",
  metadata: {
    provider: "CHANNEX",
    channexPropertyId: "certified-property",
    channexRatePlanId: "certified-rate",
    preserved: "unchanged",
  },
  updatedAt: new Date("2026-08-20T12:00:00.000Z"),
  connection: {
    id: "pms-connection-1",
    organizationId: "org-1",
    provider: "CHANNEX",
    status: "ACTIVE",
  },
};

test("snapshot query and returned evidence remain tenant scoped", async () => {
  const { repository, reads } = setup(record);
  const snapshot = await repository.loadTenantSnapshot("org-1", "property-1");
  assert.deepEqual(reads[0].where, {
    organizationId: "org-1",
    propertyId: "property-1",
    platform: "CHANNEX",
  });
  assert.equal(snapshot?.currency, "USD");
  assert.equal(snapshot?.externalPropertyId, "property-ext");
  assert.equal(snapshot?.externalPrimaryRoomTypeId, "room-ext");
  assert.equal(snapshot?.externalPrimaryRatePlanId, null);
  assert.equal(snapshot?.propertyLastErrorCode, "OTA_PROVIDER_REJECTED");
});

test("cross-tenant group evidence fails closed", async () => {
  const { repository } = setup({ ...record, group: { ...record.group, organizationId: "org-other" } });
  await assert.rejects(
    repository.loadTenantSnapshot("org-1", "property-1"),
    /OTA_DISTRIBUTION_TENANT_MISMATCH/
  );
});

test("claims and checkpoints use exact tenant, platform and state fences", async () => {
  const { repository, groupUpdates, propertyUpdates } = setup(record);
  assert.equal(await repository.claimGroup("org-1", "group-1"), true);
  assert.equal(await repository.claimProperty("org-1", "distribution-property-1"), true);
  await repository.checkpointProperty("org-1", "distribution-property-1", "property-ext");
  await repository.checkpointPrimaryRoomType("org-1", "distribution-property-1", "room-ext");

  assert.deepEqual(groupUpdates[0].where.provisioningStatus, { in: ["NOT_PROVISIONED", "FAILED"] });
  assert.equal(groupUpdates[0].where.organizationId, "org-1");
  assert.deepEqual(propertyUpdates[0].where.provisioningStatus, { in: ["NOT_PROVISIONED", "FAILED"] });
  assert.deepEqual(propertyUpdates[1].data, { externalPropertyId: "property-ext" });
  assert.deepEqual(propertyUpdates[2].data, { externalPrimaryRoomTypeId: "room-ext" });
});

test("invalid currency is rejected before database access", () => {
  assert.throws(
    () => new PrismaOtaProvisioningRepository(setup(record).repository as any, "US dollars"),
    (error: unknown) =>
      error instanceof OtaProvisioningRepositoryError &&
      error.code === "OTA_DEFAULT_CURRENCY_INVALID"
  );
});

const readyDistributionRecord = {
  ...record,
  provisioningStatus: "READY",
  externalPropertyId: "canonical-property",
  externalPrimaryRoomTypeId: "canonical-room",
  externalPrimaryRatePlanId: "canonical-rate",
};

test("aligns the unique PMS listing to the READY DistributionProperty without changing distribution", async () => {
  const { repository, propertyUpdates, pmsUpdates, audits } = setup(
    readyDistributionRecord,
    [legacyListing]
  );
  const result = await repository.alignPmsListingToReadyDistributionMapping(
    "org-1",
    "property-1",
    "user-1",
    new Date("2026-09-12T13:00:00.000Z")
  );
  assert.equal(result, "ALIGNED");
  assert.equal(propertyUpdates.length, 0);
  assert.deepEqual(pmsUpdates[0].where, {
    id: "listing-1",
    connectionId: "pms-connection-1",
    propertyId: "property-1",
    externalListingId: "certified-room",
    updatedAt: new Date("2026-08-20T12:00:00.000Z"),
    connection: {
      organizationId: "org-1",
      provider: "CHANNEX",
      status: "ACTIVE",
    },
  });
  assert.deepEqual(pmsUpdates[0].data, {
    externalListingId: "canonical-room",
    metadata: {
      provider: "CHANNEX",
      channexPropertyId: "canonical-property",
      channexRatePlanId: "canonical-rate",
      preserved: "unchanged",
    },
  });
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0].data.eventType,
    "PMS_LISTING_ALIGNED_TO_DISTRIBUTION_MAPPING"
  );
  assert.equal(audits[0].data.completedAt.toISOString(), "2026-09-12T13:00:00.000Z");
  assert.deepEqual(audits[0].data.metadata.canonical, {
    externalPropertyId: "canonical-property",
    externalPrimaryRoomTypeId: "canonical-room",
    externalPrimaryRatePlanId: "canonical-rate",
  });
});

test("an already aligned PMS mapping is idempotent", async () => {
  const alignedListing = {
    ...legacyListing,
    externalListingId: "canonical-room",
    metadata: {
      ...legacyListing.metadata,
      channexPropertyId: "canonical-property",
      channexRatePlanId: "canonical-rate",
    },
  };
  const { repository, propertyUpdates, pmsUpdates, audits } = setup(
    readyDistributionRecord,
    [alignedListing]
  );
  assert.equal(
    await repository.alignPmsListingToReadyDistributionMapping(
      "org-1",
      "property-1",
      "user-1",
      new Date()
    ),
    "ALREADY_ALIGNED"
  );
  assert.equal(propertyUpdates.length, 0);
  assert.equal(pmsUpdates.length, 0);
  assert.equal(audits.length, 0);
});

test("PMS alignment fails closed for zero, multiple, foreign-tenant, and invalid metadata listings", async (t) => {
  const scenarios = [
    { name: "zero", listings: [], code: "OTA_CERTIFIED_PMS_LISTING_CARDINALITY_INVALID" },
    { name: "multiple", listings: [legacyListing, { ...legacyListing, id: "listing-2" }], code: "OTA_CERTIFIED_PMS_LISTING_CARDINALITY_INVALID" },
    { name: "foreign tenant", listings: [{ ...legacyListing, connection: { ...legacyListing.connection, organizationId: "org-2" } }], code: "OTA_DISTRIBUTION_TENANT_MISMATCH" },
    { name: "invalid metadata", listings: [{ ...legacyListing, metadata: [] }], code: "OTA_CERTIFIED_PMS_LISTING_METADATA_INVALID" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { repository, propertyUpdates, pmsUpdates, audits } = setup(
        readyDistributionRecord,
        scenario.listings
      );
      await assert.rejects(
        repository.alignPmsListingToReadyDistributionMapping("org-1", "property-1", "user-1", new Date()),
        (error: unknown) =>
          error instanceof OtaProvisioningRepositoryError && error.code === scenario.code
      );
      assert.equal(propertyUpdates.length, 0);
      assert.equal(pmsUpdates.length, 0);
      assert.equal(audits.length, 0);
    });
  }
});

test("PMS alignment rejects a non-ready distribution mapping before any listing write", async () => {
  const { repository, pmsUpdates, audits } = setup(record, [legacyListing]);
  await assert.rejects(
    repository.alignPmsListingToReadyDistributionMapping(
      "org-1",
      "property-1",
      "user-1",
      new Date()
    ),
    (error: unknown) =>
      error instanceof OtaProvisioningRepositoryError &&
      error.code === "OTA_DISTRIBUTION_MAPPING_NOT_READY"
  );
  assert.equal(pmsUpdates.length, 0);
  assert.equal(audits.length, 0);
});

const onboardingAt = new Date("2026-09-13T15:00:00.000Z");

// In-memory transactional double: exercises repository composition without
// Prisma connections or HTTP. Rollback assertions are not a live DB test.
function onboardingFixture(connection: any = null) {
  let state = {
    distribution: structuredClone(readyDistributionRecord),
    connection: structuredClone(connection),
    listings: [] as any[],
    audits: [] as any[],
  };
  const transactions: any[] = [];
  const faults = { audit: false, listing: false, transaction: false };
  const client = {
    property: {
      async findFirst() {
        return {
          id: "property-1", organizationId: "org-1", status: "ACTIVE",
          distributionEnabled: true, distributionStatus: "ACTIVE",
        };
      },
    },
    distributionProperty: {
      async findFirst(args: any) {
        assert.equal(args.where.organizationId, "org-1");
        assert.equal(args.where.platform, "CHANNEX");
        assert.equal(args.where.propertyId, "property-1");
        return structuredClone(state.distribution);
      },
      async updateMany(args: any) {
        assert.equal(args.where.organizationId, "org-1");
        assert.equal(args.where.id, state.distribution.id);
        Object.assign(state.distribution, args.data);
        return { count: 1 };
      },
    },
    distributionGroup: {
      async updateMany() { throw new Error("Existing group must not be changed"); },
    },
    pmsConnection: {
      async findUnique(args: any) {
        assert.deepEqual(args.where.organizationId_provider, { organizationId: "org-1", provider: "CHANNEX" });
        return structuredClone(state.connection);
      },
      async create(args: any) {
        assert.equal(state.connection, null);
        state.connection = { id: "new-connection", ...structuredClone(args.data) };
        return structuredClone(state.connection);
      },
    },
    pmsListing: {
      async findMany(args: any) {
        assert.equal(args.where.propertyId, "property-1");
        assert.equal(args.take, 2);
        return state.listings.filter(x => x.propertyId === args.where.propertyId)
          .slice(0, 2).map(x => ({ ...structuredClone(x), connection: structuredClone(state.connection) }));
      },
      async findUnique(args: any) {
        const target = args.where.connectionId_externalListingId;
        return state.listings.find(x => x.connectionId === target.connectionId && x.externalListingId === target.externalListingId) ?? null;
      },
      async create(args: any) {
        if (faults.listing) throw new Error("MOCK_LISTING_FAILURE");
        const listing = { id: "new-listing", updatedAt: onboardingAt, ...structuredClone(args.data) };
        state.listings.push(listing);
        return structuredClone(listing);
      },
      async updateMany() { throw new Error("Onboarding must not rewrite an existing aligned listing"); },
    },
    apmsAuditEntry: {
      async create(args: any) {
        if (faults.audit) throw new Error("MOCK_AUDIT_FAILURE");
        state.audits.push(structuredClone(args.data));
        return { id: "new-audit" };
      },
    },
    async $transaction<T>(work: (tx: any) => Promise<T>, options?: any) {
      transactions.push(options);
      const before = structuredClone(state);
      try {
        const result = await work(client);
        if (faults.transaction) throw Object.assign(new Error("MOCK_SERIALIZATION_FAILURE"), { code: "P2034" });
        return result;
      } catch (error) {
        state = before;
        throw error;
      }
    },
  };
  const repository = new PrismaOtaProvisioningRepository(client, "USD");
  return {
    client, repository, faults, transactions,
    get state() { return state; },
    ensure: () => repository.alignPmsListingToReadyDistributionMapping(
      "org-1", "property-1", "user-1", onboardingAt, { createIfMissing: true }
    ),
  };
}

test("onboarding creates the tenant connection, listing and audit atomically and passes ARI mapping", async () => {
  const f = onboardingFixture();
  assert.equal(await f.ensure(), "CREATED");
  assert.deepEqual(f.transactions, [{ isolationLevel: "Serializable" }]);
  assert.equal(f.state.connection.organizationId, "org-1");
  assert.equal(f.state.connection.provider, "CHANNEX");
  assert.equal(f.state.connection.status, "ACTIVE");
  assert.equal(f.state.listings.length, 1);
  assert.equal(f.state.listings[0].propertyId, "property-1");
  assert.equal(f.state.listings[0].name, "Casa Uno");
  const mapping = await resolveChannexAriMapping(f.client as any, {
    organizationId: "org-1", propertyId: "property-1",
  });
  assert.equal(mapping.externalRoomTypeId, "canonical-room");
  assert.equal(mapping.channexPropertyId, "canonical-property");
  assert.equal(mapping.channexRatePlanId, "canonical-rate");
  assertFullSyncCanonicalMappingConsistency({
    organizationId: "org-1", propertyId: "property-1",
    legacyMapping: mapping, canonicalMapping: f.state.distribution,
  });
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].eventType, "PMS_LISTING_CREATED_FROM_DISTRIBUTION_MAPPING");
  assert.equal(f.state.audits[0].metadata.requestedByUserId, "user-1");
  assert.equal(f.state.audits[0].metadata.pmsListingId, mapping.listingId);
  assert.deepEqual(f.state.audits[0].metadata.canonical, {
    externalPropertyId: "canonical-property",
    externalPrimaryRoomTypeId: "canonical-room",
    externalPrimaryRatePlanId: "canonical-rate",
  });
  const beforeRepeat = structuredClone(f.state);
  assert.equal(await f.ensure(), "ALREADY_ALIGNED");
  assert.deepEqual(f.state, beforeRepeat);
});

test("onboarding reuses shared connection without changing credentials, metadata or other listings", async () => {
  const connection = { ...legacyListing.connection, metadata: { unrelated: "keep" }, credentialsEncrypted: "opaque-fixture", webhookSecret: "opaque-webhook-fixture" };
  const f = onboardingFixture(connection);
  const otherListing = { id: "other-listing", connectionId: connection.id, propertyId: "property-2", externalListingId: "other-room", metadata: { keep: true } };
  f.state.listings.push(structuredClone(otherListing));
  const distributionBefore = structuredClone(f.state.distribution);
  await f.ensure();
  assert.deepEqual(f.state.connection, connection);
  assert.deepEqual(f.state.listings[0], otherListing);
  assert.deepEqual(f.state.distribution, distributionBefore);
  assert.equal(f.state.listings[1].connectionId, connection.id);
});

test("onboarding fails closed on ambiguous, foreign, inactive or incomplete evidence", async (t) => {
  const scenarios = [
    { name: "multiple listings", code: "CARDINALITY_INVALID", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.listings.push(legacyListing, { ...legacyListing, id: "second" }); } },
    { name: "foreign listing tenant", code: "TENANT_MISMATCH", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.listings.push(legacyListing); f.state.connection.organizationId = "org-2"; } },
    { name: "foreign connection", code: "TENANT_MISMATCH", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.connection.organizationId = "org-2"; } },
    { name: "wrong provider", code: "TENANT_MISMATCH", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.connection.provider = "OTHER"; } },
    { name: "inactive connection", code: "CONNECTION_NOT_ACTIVE", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.connection.status = "DISABLED"; } },
    { name: "foreign property", code: "TENANT_MISMATCH", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.distribution.property.organizationId = "org-2"; } },
    { name: "foreign group", code: "TENANT_MISMATCH", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.distribution.group.organizationId = "org-2"; } },
    { name: "not ready", code: "MAPPING_NOT_READY", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.distribution.provisioningStatus = "PROVISIONING"; } },
    { name: "missing rate", code: "RATE_PLAN_ID_REQUIRED", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.distribution.externalPrimaryRatePlanId = ""; } },
    { name: "room linked elsewhere", code: "ROOM_ALREADY_LINKED", mutate: (f: ReturnType<typeof onboardingFixture>) => { f.state.listings.push({ id: "other", connectionId: f.state.connection.id, propertyId: "property-2", externalListingId: "canonical-room" }); } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const f = onboardingFixture(legacyListing.connection);
      scenario.mutate(f);
      const before = structuredClone(f.state);
      await assert.rejects(f.ensure(), new RegExp(scenario.code));
      assert.deepEqual(f.state, before);
    });
  }
});

test("listing, audit and serialization failures roll back local creation without blind retry", async (t) => {
  for (const fault of ["listing", "audit", "transaction"] as const) {
    await t.test(fault, async () => {
      const f = onboardingFixture();
      f.faults[fault] = true;
      const before = structuredClone(f.state);
      await assert.rejects(f.ensure(), /MOCK_/);
      assert.deepEqual(f.state, before);
      assert.equal(f.transactions.length, 1);
      f.faults[fault] = false;
      assert.equal(await f.ensure(), "CREATED");
      assert.equal(f.state.listings.length, 1);
      assert.equal(f.state.audits.length, 1);
    });
  }
});

test("canonical prepare with no listing completes linkage; retry after local failure does not reprovision", async () => {
  const f = onboardingFixture();
  f.state.distribution.provisioningStatus = "NOT_PROVISIONED";
  f.state.distribution.externalPropertyId = "";
  f.state.distribution.externalPrimaryRoomTypeId = "";
  f.state.distribution.externalPrimaryRatePlanId = "";
  const providerCalls: string[] = [];
  const actions = buildOtaConnectionCenterComposition({
    prisma: f.client as any, repository: f.repository,
    runtimeValue: "true", defaultCurrency: "USD",
    trustedMutationOrigins: ["https://app.pin-ngo.com"],
    allowedLaunchOrigins: ["https://app.channex.io"],
    prepareLogicalConnection: async () => ({} as any),
    configureBookingWebhook: async ({ organizationId, propertyId }) => {
      assert.equal(organizationId, "org-1");
      assert.equal(propertyId, "property-1");
      return { verified: true };
    },
    adapter: {
      async ensureGroup() { throw new Error("Existing group must be reused"); },
      async ensureProperty() { providerCalls.push("property"); return { externalPropertyId: "canonical-property" }; },
      async ensurePrimaryRoomType() { providerCalls.push("room"); return { externalPrimaryRoomTypeId: "canonical-room" }; },
      async ensurePrimaryRatePlan() { providerCalls.push("rate"); return { externalPrimaryRatePlanId: "canonical-rate" }; },
      async issue() { throw new Error("Prepare must not start OTA authorization"); },
    },
  });
  const input = { organizationId: "org-1", propertyId: "property-1", requestedByUserId: "user-1", provider: "AIRBNB" as const, requestKey: "new-host-1" };
  assert.ok(actions.prepare);
  f.faults.audit = true;
  await assert.rejects(actions.prepare(input), /MOCK_AUDIT_FAILURE/);
  assert.equal(f.state.distribution.provisioningStatus, "READY");
  assert.equal(f.state.connection, null);
  assert.equal(f.state.listings.length, 0);
  f.faults.audit = false;
  assert.deepEqual(await actions.prepare(input), { provisioningStatus: "READY" });
  assert.equal(f.state.listings.length, 1);
  assert.equal(f.state.audits.length, 1);
  const mapping = await resolveChannexAriMapping(f.client as any, input);
  assertFullSyncCanonicalMappingConsistency({ ...input, legacyMapping: mapping, canonicalMapping: f.state.distribution });
  assert.deepEqual(await actions.prepare(input), { provisioningStatus: "READY" });
  assert.deepEqual(providerCalls, ["property", "room", "rate"]);
  assert.equal(f.state.listings.length, 1);
  assert.equal(f.state.audits.length, 1);
});
