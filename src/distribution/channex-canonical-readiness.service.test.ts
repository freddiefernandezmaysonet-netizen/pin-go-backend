import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalOtaReadinessServiceError,
  reconcileCanonicalOtaReadiness,
} from "./channex-canonical-readiness.service.js";
import { ChannexReadonlyTransportError } from "./channex-readonly.http-transport.js";
import { calculateChannexAriCanonicalJsonIntegrity } from "../pms/outbound/channex-ari-canonical-json.policy.js";
import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
} from "../pms/outbound/channex-ari-lifecycle.policy.js";

const EXTERNAL_PROPERTY_ID = "faf0559d-965f-426c-8303-107b0b1bc5ff";
const EXTERNAL_ROOM_TYPE_ID = "8f134234-a0e6-4edb-9ed0-2224ecc35716";
const EXTERNAL_RATE_PLAN_ID = "6bc6858c-438b-4c3c-8917-12c9bd260b71";
const EXTERNAL_CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CHANNEL_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_GROUP_ID = "33333333-3333-4333-8333-333333333333";
const OUTBOUND_MAPPING_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CHANNEL_GROUP_ID = "55555555-5555-4555-8555-555555555555";

const ORGANIZATION_ID = "org-1";
const PROPERTY_ID = "prop-1";
const DISTRIBUTION_GROUP_ID = "distribution-group-1";
const DISTRIBUTION_PROPERTY_ID = "distribution-property-1";
const CONNECTION_ID = "ota-connection-1";
const PMS_CONNECTION_ID = "pms-connection-1";
const PMS_LISTING_ID = "pms-listing-1";
const REQUESTED_BY_USER_ID = "user-1";
const UPDATED_AT = new Date("2026-09-07T00:00:10.000Z");
const ACTIVATED_AT = new Date("2026-09-07T00:00:00.123Z");
const LIFECYCLE_OCCURRED_AT = new Date("2026-09-07T00:00:00.123Z");
const LIFECYCLE_OCCURRED_AT_MICROS =
  BigInt(LIFECYCLE_OCCURRED_AT.getTime()) * 1_000n + 456n;
const FULL_SYNC_REQUESTED_AT = new Date("2026-09-07T00:00:00.125Z");
const FULL_SYNC_COMPLETED_AT = new Date("2026-09-07T00:00:00.126Z");
const NOW = new Date("2026-09-07T01:00:00.000Z");

type DiscoveryMode = "UNIQUE" | "AMBIGUOUS" | "NOT_FOUND";
type ExactResource = "PROPERTY" | "ROOM_TYPE" | "RATE_PLAN";
type ChannelTransportPhase = "COLLECTION" | "EXACT";
type DistributionGroupMode =
  | "VALID"
  | "MISSING"
  | "RELATION_ID_MISMATCH"
  | "TENANT_MISMATCH"
  | "STATUS_NOT_READY"
  | "EXTERNAL_ID_INVALID";

type FixtureOptions = {
  externalConnectionId?: string | null;
  externalListingId?: string | null;
  channelListingId?: string;
  invalidChannelCollectionContract?: boolean;
  invalidChannelResourceContract?: boolean;
  channelTransportFailure?: {
    phase: ChannelTransportPhase;
    code:
      | "OTA_READONLY_PROVIDER_RESPONSE_INVALID"
      | "OTA_READONLY_PROVIDER_RATE_LIMITED"
      | "OTA_READONLY_PROVIDER_UNAVAILABLE";
  };
  discovery?: DiscoveryMode;
  lifecycle?:
    | "new_channel"
    | "updated_channel"
    | "activate_channel"
    | "deactivate_channel"
    | "disconnect_channel"
    | "disconnect_listing";
  channelActive?: boolean;
  includeChannelOperationalStatus?: boolean;
  channelOperationalStatus?: unknown;
  status?: "NOT_CONNECTED" | "ACTIVE" | "DEGRADED";
  activatedAt?: Date | null;
  channelRead?: "FOUND" | "NOT_FOUND";
  fullSync?: "QUALIFIED" | "PREDATES_LIFECYCLE" | "INVALID_DATE";
  outboxMapping?: "VERIFIED" | "MISMATCH";
  pmsMapping?: "VERIFIED" | "MISMATCH";
  tenantMismatch?: boolean;
  updateCount?: number;
  existingAudit?: boolean;
  auditCreateP2002Once?: boolean;
  nonDecisionP2002At?: "UPDATE" | "AUDIT_CREATE";
  mappingChangedAfterFullSyncRequest?: boolean;
  transactionEvidenceMutation?: boolean;
  readinessRevision?: number;
  auditRecordOverrides?: Record<string, unknown>;
  auditMetadataOverrides?: Record<string, unknown>;
  distributionGroup?: DistributionGroupMode;
  distributionPropertyRelation?:
    | "VALID"
    | "PROPERTY_ID_MISMATCH"
    | "PROPERTY_TENANT_MISMATCH";
  channelGroupMismatch?: boolean;
  exactReadFailure?: {
    resource: ExactResource;
    code:
      | "OTA_READONLY_RESOURCE_NOT_FOUND"
      | "OTA_READONLY_PROVIDER_RATE_LIMITED"
      | "OTA_READONLY_PROVIDER_UNAVAILABLE";
  };
};

function propertyPayload() {
  return {
    data: {
      type: "property",
      id: EXTERNAL_PROPERTY_ID,
      attributes: { id: EXTERNAL_PROPERTY_ID },
    },
  };
}

function roomTypePayload() {
  return {
    data: {
      type: "room_type",
      id: EXTERNAL_ROOM_TYPE_ID,
      attributes: { id: EXTERNAL_ROOM_TYPE_ID },
      relationships: {
        property: {
          data: { type: "property", id: EXTERNAL_PROPERTY_ID },
        },
      },
    },
  };
}

function ratePlanPayload() {
  return {
    data: {
      type: "rate_plan",
      id: EXTERNAL_RATE_PLAN_ID,
      attributes: { id: EXTERNAL_RATE_PLAN_ID },
      relationships: {
        property: {
          data: { type: "property", id: EXTERNAL_PROPERTY_ID },
        },
        room_type: {
          data: { type: "room_type", id: EXTERNAL_ROOM_TYPE_ID },
        },
      },
    },
  };
}

function channelPayload(
  channelId = EXTERNAL_CHANNEL_ID,
  active = true,
  groupId = CHANNEL_GROUP_ID,
  listingId = "airbnb-listing-1",
  operationalStatus?: unknown,
  includeOperationalStatus = false
) {
  return {
    data: {
      type: "channel",
      id: channelId,
      attributes: {
        id: channelId,
        channel: "Airbnb",
        is_active: active,
        ...(includeOperationalStatus ? { status: operationalStatus } : {}),
        properties: [EXTERNAL_PROPERTY_ID],
        rate_plans: [
          {
            id: OUTBOUND_MAPPING_ID,
            rate_plan_id: EXTERNAL_RATE_PLAN_ID,
            settings: { listing_id: listingId },
          },
        ],
      },
      relationships: {
        properties: {
          data: [{ type: "property", id: EXTERNAL_PROPERTY_ID }],
        },
        group: { data: { type: "group", id: groupId } },
        known_mappings: { data: [] },
      },
    },
  };
}

function discoveryPayload(mode: DiscoveryMode) {
  const candidates =
    mode === "NOT_FOUND"
      ? []
      : mode === "AMBIGUOUS"
        ? [
            channelPayload(EXTERNAL_CHANNEL_ID).data,
            channelPayload(SECOND_CHANNEL_ID).data,
          ]
        : [channelPayload(EXTERNAL_CHANNEL_ID).data];
  return {
    data: candidates,
    meta: { page: 1, limit: 100, total: candidates.length },
  };
}

function invalidChannelCollectionPayload() {
  const channel = channelPayload().data;
  return {
    data: [
      {
        ...channel,
        attributes: {
          ...channel.attributes,
          properties: ["not-a-uuid"],
        },
      },
    ],
    meta: { page: 1, limit: 100, total: 1 },
  };
}

function invalidChannelResourcePayload() {
  const channel = channelPayload().data;
  return {
    data: {
      ...channel,
      relationships: {
        ...channel.relationships,
        group: { data: { type: "group", id: "not-a-uuid" } },
      },
    },
  };
}

function fullSyncOutboxPair(args: {
  requestedAt: Date;
  completedAt: Date;
  mapping: "VERIFIED" | "MISMATCH";
}) {
  const ratePlanId =
    args.mapping === "MISMATCH" ? SECOND_CHANNEL_ID : EXTERNAL_RATE_PLAN_ID;
  const dateFrom = "2026-09-08";
  const dateToExclusive = addUtcDays(dateFrom, CHANNEX_ARI_FULL_SYNC_DAYS);
  const inclusiveDateTo = addUtcDays(
    dateFrom,
    CHANNEX_ARI_FULL_SYNC_DAYS - 1
  );
  const availabilityPayload = {
    values: [
      {
        property_id: EXTERNAL_PROPERTY_ID,
        room_type_id: EXTERNAL_ROOM_TYPE_ID,
        date_from: dateFrom,
        date_to: inclusiveDateTo,
        availability: 1,
      },
    ],
  };
  const ratesPayload = {
    values: [
      {
        property_id: EXTERNAL_PROPERTY_ID,
        rate_plan_id: ratePlanId,
        date_from: dateFrom,
        date_to: inclusiveDateTo,
        rate: "10",
        min_stay_arrival: 1,
        min_stay_through: 1,
        max_stay: 0,
      },
    ],
  };
  const availabilityIntegrity = calculateChannexAriCanonicalJsonIntegrity(
    availabilityPayload
  );
  const ratesIntegrity = calculateChannexAriCanonicalJsonIntegrity(
    ratesPayload
  );
  const horizon = {
    dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
    dateToExclusive: new Date(`${dateToExclusive}T00:00:00.000Z`),
    dateKeys: [] as string[],
  };
  return [
    {
      id: "outbox-availability",
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      provider: "CHANNEX",
      messageKind: "AVAILABILITY",
      syncMode: "FULL",
      scope: "FULL_HORIZON",
      status: "MERGED",
      correlationId: "full-sync-correlation-1",
      ...horizon,
      createdAt: args.requestedAt,
      deliveryId: "delivery-availability",
      delivery: {
        id: "delivery-availability",
        organizationId: ORGANIZATION_ID,
        propertyId: PROPERTY_ID,
        connectionId: PMS_CONNECTION_ID,
        listingId: PMS_LISTING_ID,
        messageKind: "AVAILABILITY",
        syncMode: "FULL",
        scope: "FULL_HORIZON",
        ...horizon,
        status: "SENT",
        sentAt: args.requestedAt,
        payload: availabilityPayload,
        payloadHash: availabilityIntegrity.payloadHash,
        payloadValueCount: availabilityPayload.values.length,
        payloadBytes: availabilityIntegrity.payloadBytes,
      },
    },
    {
      id: "outbox-rates",
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      provider: "CHANNEX",
      messageKind: "RATES_RESTRICTIONS",
      syncMode: "FULL",
      scope: "FULL_HORIZON",
      status: "MERGED",
      correlationId: "full-sync-correlation-1",
      ...horizon,
      createdAt: args.requestedAt,
      deliveryId: "delivery-rates",
      delivery: {
        id: "delivery-rates",
        organizationId: ORGANIZATION_ID,
        propertyId: PROPERTY_ID,
        connectionId: PMS_CONNECTION_ID,
        listingId: PMS_LISTING_ID,
        messageKind: "RATES_RESTRICTIONS",
        syncMode: "FULL",
        scope: "FULL_HORIZON",
        ...horizon,
        status: "SENT",
        sentAt: args.completedAt,
        payload: ratesPayload,
        payloadHash: ratesIntegrity.payloadHash,
        payloadValueCount: ratesPayload.values.length,
        payloadBytes: ratesIntegrity.payloadBytes,
      },
    },
  ];
}

function fixture(options: FixtureOptions = {}) {
  const externalConnectionId =
    options.externalConnectionId === undefined
      ? EXTERNAL_CHANNEL_ID
      : options.externalConnectionId;
  const externalListingId =
    options.externalListingId === undefined
      ? null
      : options.externalListingId;
  const configuredReadinessRevision =
    options.readinessRevision ?? (options.existingAudit ? 1 : 0);
  const lifecycle = options.lifecycle ?? "activate_channel";
  const lifecyclePrecedence = {
    new_channel: 10,
    updated_channel: 20,
    activate_channel: 30,
    deactivate_channel: 40,
    disconnect_listing: 50,
    disconnect_channel: 60,
  }[lifecycle];
  const updates: any[] = [];
  const audits: any[] = [];
  const transactionIsolationLevels: Array<string | undefined> = [];
  let auditLookups = 0;
  let topLevelAuditLookups = 0;
  let p2002Thrown = false;
  const reads = {
    property: [] as string[],
    roomType: [] as string[],
    ratePlan: [] as string[],
    channelCollection: [] as Array<{ propertyId: string; channel?: string }>,
    channel: [] as string[],
    legacyRoomTypeCollection: 0,
    legacyRatePlanCollection: 0,
  };

  function distributionPropertyRecord() {
    const groupMode = options.distributionGroup ?? "VALID";
    const group =
      groupMode === "MISSING"
        ? null
        : {
            id:
              groupMode === "RELATION_ID_MISMATCH"
                ? "other-distribution-group"
                : DISTRIBUTION_GROUP_ID,
            organizationId:
              groupMode === "TENANT_MISMATCH"
                ? "other-org"
                : ORGANIZATION_ID,
            platform: "CHANNEX",
            externalGroupId:
              groupMode === "EXTERNAL_ID_INVALID"
                ? "not-a-uuid"
                : CHANNEL_GROUP_ID,
            provisioningStatus:
              groupMode === "STATUS_NOT_READY" ? "PROVISIONING" : "READY",
            updatedAt: new Date("2026-09-07T00:00:00.100Z"),
          };
    return {
      id: DISTRIBUTION_PROPERTY_ID,
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      groupId: DISTRIBUTION_GROUP_ID,
      platform: "CHANNEX",
      externalPropertyId: EXTERNAL_PROPERTY_ID,
      externalPrimaryRoomTypeId: EXTERNAL_ROOM_TYPE_ID,
      externalPrimaryRatePlanId: EXTERNAL_RATE_PLAN_ID,
      provisioningStatus: "READY" as const,
      updatedAt: new Date("2026-09-07T00:00:00.100Z"),
      property: {
        id:
          options.distributionPropertyRelation === "PROPERTY_ID_MISMATCH"
            ? "other-property"
            : PROPERTY_ID,
        organizationId:
          options.distributionPropertyRelation === "PROPERTY_TENANT_MISMATCH"
            ? "other-org"
            : ORGANIZATION_ID,
      },
      group,
    };
  }

  function connectionRecord() {
    return {
      id: CONNECTION_ID,
      organizationId: options.tenantMismatch ? "other-org" : ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      distributionPropertyId: DISTRIBUTION_PROPERTY_ID,
      provider: "AIRBNB" as const,
      externalConnectionId,
      externalChannelCode: externalConnectionId ? "ABB" : null,
      externalListingId,
      status: options.status ?? ("NOT_CONNECTED" as const),
      paymentReadiness: "NOT_STARTED" as const,
      taxReadiness: "NOT_STARTED" as const,
      contentReadiness: "NOT_STARTED" as const,
      activationRequestedAt: null,
      activatedAt:
        options.activatedAt !== undefined
          ? options.activatedAt
          : options.status === "ACTIVE"
            ? ACTIVATED_AT
            : null,
      lastFullSyncConfirmedAt: null,
      lastLifecycleOccurredAt: LIFECYCLE_OCCURRED_AT,
      lastLifecycleOccurredAtMicros: LIFECYCLE_OCCURRED_AT_MICROS,
      lastLifecycleEventType: lifecycle,
      lastLifecycleEventPrecedence: lifecyclePrecedence,
      channelAuthorizationVerifiedAt: LIFECYCLE_OCCURRED_AT,
      lastChannelActivatedAt: ACTIVATED_AT,
      readinessRevision: configuredReadinessRevision,
      updatedAt: UPDATED_AT,
    };
  }

  function propertyStateRecord() {
    const predates = options.fullSync === "PREDATES_LIFECYCLE";
    const invalid = options.fullSync === "INVALID_DATE";
    return {
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      lastFullSyncRequestedAt: invalid
        ? new Date(Number.NaN)
        : predates
          ? new Date("2026-09-06T23:59:00.000Z")
          : FULL_SYNC_REQUESTED_AT,
      lastFullSyncCompletedAt: predates
        ? new Date("2026-09-06T23:59:30.000Z")
        : FULL_SYNC_COMPLETED_AT,
      updatedAt: new Date("2026-09-07T00:00:00.127Z"),
    };
  }

  function pmsListingRecords(transactional = false) {
    const baseUpdatedAt = options.mappingChangedAfterFullSyncRequest
      ? new Date("2026-09-07T00:00:00.126Z")
      : new Date("2026-09-07T00:00:00.100Z");
    return [
      {
        id: PMS_LISTING_ID,
        connectionId: PMS_CONNECTION_ID,
        propertyId: PROPERTY_ID,
        externalListingId:
          options.pmsMapping === "MISMATCH"
            ? SECOND_CHANNEL_ID
            : EXTERNAL_ROOM_TYPE_ID,
        metadata: {
          provider: "CHANNEX",
          channexPropertyId: EXTERNAL_PROPERTY_ID,
          channexRatePlanId: EXTERNAL_RATE_PLAN_ID,
        },
        updatedAt:
          transactional && options.transactionEvidenceMutation
            ? new Date("2026-09-07T00:00:00.999Z")
            : baseUpdatedAt,
        connection: {
          id: PMS_CONNECTION_ID,
          organizationId: ORGANIZATION_ID,
          provider: "CHANNEX",
          status: "ACTIVE",
          updatedAt: baseUpdatedAt,
        },
      },
    ];
  }

  function outboxEvidenceRecords() {
    const predates = options.fullSync === "PREDATES_LIFECYCLE";
    const requestedAt = predates
      ? new Date("2026-09-06T23:59:00.000Z")
      : FULL_SYNC_REQUESTED_AT;
    const completedAt = predates
      ? new Date("2026-09-06T23:59:30.000Z")
      : FULL_SYNC_COMPLETED_AT;
    return fullSyncOutboxPair({
      requestedAt,
      completedAt,
      mapping: options.outboxMapping ?? "VERIFIED",
    });
  }

  const initialReadinessRevision = configuredReadinessRevision;

  function persistedAuditRecord(canonicalRevision: number) {
    const metadata = {
      requestedByUserId: REQUESTED_BY_USER_ID,
      authorizationReadiness: "READY",
      mappingReadiness: "READY",
      distributionReadiness: "READY",
      reasons: ["PERSISTED_WINNER"],
      readinessRevision: {
        previous: canonicalRevision - 1,
        canonical: canonicalRevision,
      },
      ...options.auditMetadataOverrides,
    };
    return {
      id: "existing-audit",
      organizationId: ORGANIZATION_ID,
      propertyId: PROPERTY_ID,
      entityType: "DISTRIBUTION",
      entityId: CONNECTION_ID,
      engine: "OTA_DISTRIBUTION",
      eventType: "DECISION_APPLIED",
      status: "SUCCESS",
      metadata,
      ...options.auditRecordOverrides,
    };
  }

  const tx = {
    distributionProperty: {
      async findFirst() {
        return distributionPropertyRecord();
      },
    },
    otaChannelConnection: {
      async findFirst() {
        return {
          id: CONNECTION_ID,
          organizationId: ORGANIZATION_ID,
          propertyId: PROPERTY_ID,
          readinessRevision:
            options.auditCreateP2002Once && p2002Thrown
              ? initialReadinessRevision + 1
              : initialReadinessRevision,
        };
      },
      async updateMany(args: any) {
        updates.push(args);
        if (options.nonDecisionP2002At === "UPDATE") {
          throw {
            code: "P2002",
            meta: { target: ["provider", "externalListingId"] },
          };
        }
        return { count: options.updateCount ?? 1 };
      },
    },
    channexAriPropertyState: {
      async findUnique() {
        return propertyStateRecord();
      },
    },
    pmsListing: {
      async findMany() {
        return pmsListingRecords(true);
      },
    },
    distributionOutboxEvent: {
      async findMany() {
        return outboxEvidenceRecords();
      },
    },
    apmsAuditEntry: {
      async findUnique() {
        auditLookups += 1;
        const concurrentWinner =
          options.auditCreateP2002Once && p2002Thrown;
        return options.existingAudit || concurrentWinner
          ? persistedAuditRecord(
              concurrentWinner
                ? initialReadinessRevision + 1
                : initialReadinessRevision
            )
          : null;
      },
      async create(args: any) {
        if (options.nonDecisionP2002At === "AUDIT_CREATE") {
          throw {
            code: "P2002",
            meta: { target: ["provider", "externalListingId"] },
          };
        }
        if (options.auditCreateP2002Once && !p2002Thrown) {
          p2002Thrown = true;
          throw { code: "P2002", meta: { target: ["decisionId"] } };
        }
        audits.push(args);
        return { id: "audit" };
      },
    },
  };

  const client = {
    distributionProperty: {
      async findFirst() {
        return distributionPropertyRecord();
      },
    },
    otaChannelConnection: {
      async findFirst() {
        return connectionRecord();
      },
    },
    channexAriPropertyState: {
      async findUnique() {
        return propertyStateRecord();
      },
    },
    pmsListing: {
      async findMany() {
        return pmsListingRecords();
      },
    },
    distributionOutboxEvent: {
      async findMany() {
        return outboxEvidenceRecords();
      },
    },
    apmsAuditEntry: {
      async findUnique() {
        topLevelAuditLookups += 1;
        return options.existingAudit
          ? persistedAuditRecord(initialReadinessRevision)
          : null;
      },
    },
    async $transaction<T>(
      work: (txClient: typeof tx) => Promise<T>,
      transactionOptions?: { isolationLevel?: "Serializable" }
    ) {
      transactionIsolationLevels.push(transactionOptions?.isolationLevel);
      return work(tx);
    },
  };

  function failExactRead(resource: ExactResource): void {
    if (options.exactReadFailure?.resource === resource) {
      throw new ChannexReadonlyTransportError(
        options.exactReadFailure.code
      );
    }
  }

  const transport = {
    async getProperty(id: string) {
      reads.property.push(id);
      failExactRead("PROPERTY");
      return propertyPayload();
    },
    async getRoomType(id: string) {
      reads.roomType.push(id);
      failExactRead("ROOM_TYPE");
      return roomTypePayload();
    },
    async getRatePlan(id: string) {
      reads.ratePlan.push(id);
      failExactRead("RATE_PLAN");
      return ratePlanPayload();
    },
    async listChannels(propertyId: string, channel?: string) {
      reads.channelCollection.push({ propertyId, channel });
      if (options.channelTransportFailure?.phase === "COLLECTION") {
        throw new ChannexReadonlyTransportError(
          options.channelTransportFailure.code
        );
      }
      if (options.invalidChannelCollectionContract) {
        return invalidChannelCollectionPayload();
      }
      return discoveryPayload(options.discovery ?? "UNIQUE");
    },
    async getChannel(id: string) {
      reads.channel.push(id);
      if (options.channelTransportFailure?.phase === "EXACT") {
        throw new ChannexReadonlyTransportError(
          options.channelTransportFailure.code
        );
      }
      if (options.channelRead === "NOT_FOUND") {
        throw new ChannexReadonlyTransportError(
          "OTA_READONLY_RESOURCE_NOT_FOUND"
        );
      }
      if (options.invalidChannelResourceContract) {
        return invalidChannelResourcePayload();
      }
      return channelPayload(
        id,
        options.channelActive ?? true,
        options.channelGroupMismatch
          ? OTHER_CHANNEL_GROUP_ID
          : CHANNEL_GROUP_ID,
        options.channelListingId ?? "airbnb-listing-1",
        options.channelOperationalStatus,
        options.includeChannelOperationalStatus ?? false
      );
    },
    async listRoomTypes() {
      reads.legacyRoomTypeCollection += 1;
      assert.fail("canonical reconciliation must use the exact room-type GET");
    },
    async listRatePlans() {
      reads.legacyRatePlanCollection += 1;
      assert.fail("canonical reconciliation must use the exact rate-plan GET");
    },
  };

  return {
    client,
    transport,
    updates,
    audits,
    reads,
    transactionIsolationLevels,
    get auditLookups() {
      return auditLookups;
    },
    get topLevelAuditLookups() {
      return topLevelAuditLookups;
    },
  };
}

async function reconcile(
  f: ReturnType<typeof fixture>,
  requestKey: string,
  requestedByUserId = REQUESTED_BY_USER_ID
) {
  return reconcileCanonicalOtaReadiness({
    client: f.client,
    transport: f.transport,
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    requestedByUserId,
    provider: "AIRBNB",
    requestKey,
    now: NOW,
  });
}

function assertNoChannexReads(f: ReturnType<typeof fixture>) {
  assert.deepEqual(f.reads.property, []);
  assert.deepEqual(f.reads.roomType, []);
  assert.deepEqual(f.reads.ratePlan, []);
  assert.deepEqual(f.reads.channelCollection, []);
  assert.deepEqual(f.reads.channel, []);
  assert.equal(f.reads.legacyRoomTypeCollection, 0);
  assert.equal(f.reads.legacyRatePlanCollection, 0);
}

test("persists ACTIVE only from exact channel, mapping, lifecycle, and post-lifecycle full-sync evidence", async () => {
  const f = fixture();
  const result = await reconcile(f, "reconcile-exact-ready-001");

  assert.deepEqual(
    {
      authorizationReadiness: result.authorizationReadiness,
      mappingReadiness: result.mappingReadiness,
      distributionReadiness: result.distributionReadiness,
    },
    {
      authorizationReadiness: "READY",
      mappingReadiness: "READY",
      distributionReadiness: "READY",
    }
  );
  assert.deepEqual(f.reads.property, [EXTERNAL_PROPERTY_ID]);
  assert.deepEqual(f.reads.roomType, [EXTERNAL_ROOM_TYPE_ID]);
  assert.deepEqual(f.reads.ratePlan, [EXTERNAL_RATE_PLAN_ID]);
  assert.deepEqual(f.reads.channel, [EXTERNAL_CHANNEL_ID]);
  assert.deepEqual(f.reads.channelCollection, [
    { propertyId: EXTERNAL_PROPERTY_ID, channel: "Airbnb" },
  ]);
  assert.equal(f.reads.legacyRoomTypeCollection, 0);
  assert.equal(f.reads.legacyRatePlanCollection, 0);

  const update = f.updates[0];
  assert.equal(update.data.status, "ACTIVE");
  assert.equal(update.where.externalListingId, null);
  assert.equal(update.data.externalConnectionId, EXTERNAL_CHANNEL_ID);
  assert.equal(update.data.externalChannelCode, "ABB");
  assert.equal(update.data.externalListingId, "airbnb-listing-1");
  assert.equal(update.data.paymentReadiness, "NOT_APPLICABLE");
  assert.equal(update.data.taxReadiness, "NOT_APPLICABLE");
  assert.equal(update.data.contentReadiness, "NOT_APPLICABLE");
  assert.deepEqual(update.data.lastFullSyncConfirmedAt, FULL_SYNC_COMPLETED_AT);
  assert.deepEqual(update.data.activatedAt, FULL_SYNC_COMPLETED_AT);
  assert.equal(update.data.lastErrorCode, null);
  assert.equal(update.data.lastErrorSummary, null);
  assert.equal("activationRequestedAt" in update.data, false);

  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].data.organizationId, ORGANIZATION_ID);
  assert.equal(f.audits[0].data.propertyId, PROPERTY_ID);
  assert.equal(f.audits[0].data.entityType, "DISTRIBUTION");
  assert.equal(f.audits[0].data.entityId, CONNECTION_ID);
  assert.equal(f.audits[0].data.engine, "OTA_DISTRIBUTION");
  assert.equal(f.audits[0].data.eventType, "DECISION_APPLIED");
  assert.equal(f.audits[0].data.status, "SUCCESS");
  const metadata = f.audits[0].data.metadata;
  assert.equal(metadata.ariCanonicalMapping.verified, true);
  assert.equal(metadata.ariCanonicalMapping.reason, "VERIFIED");
  assert.equal(metadata.fullSyncEvidence.qualified, true);
  assert.equal(metadata.fullSyncEvidence.qualificationReason, "QUALIFIED");
  assert.equal(metadata.fullSyncEvidence.otaAcceptanceVerified, false);
  assert.equal(
    metadata.fullSyncEvidence.correlationId,
    "full-sync-correlation-1"
  );
  assert.match(metadata.fullSyncEvidence.mappingFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(metadata.transportScopePolicy.applied, true);
  assert.equal(metadata.channelVerification.identityVerified, true);
  assert.equal(metadata.channelVerification.groupVerified, true);
  assert.equal(metadata.channelVerification.outboundMappingVerified, true);
  assert.equal(metadata.channelVerification.airbnbListingVerified, true);
  assert.equal(metadata.resolvedExternalListingId, "airbnb-listing-1");
  assert.equal(metadata.externalGroupId, CHANNEL_GROUP_ID);
  assert.equal(metadata.requestedByUserId, REQUESTED_BY_USER_ID);
  assert.deepEqual(metadata.readinessRevision, { previous: 0, canonical: 1 });
  assert.match(
    f.audits[0].data.decisionId,
    /^ota-canonical-readiness:[a-f0-9]{64}$/
  );
  assert.deepEqual(f.transactionIsolationLevels, ["Serializable"]);
});

test("an enabled exact channel with non-active operational status cannot persist ACTIVE", async () => {
  for (const channelOperationalStatus of [
    "pending",
    "temporal_error",
    "permanent_error",
    "unexpected",
    null,
  ]) {
    const f = fixture({
      status: "ACTIVE",
      activatedAt: ACTIVATED_AT,
      includeChannelOperationalStatus: true,
      channelOperationalStatus,
    });
    const result = await reconcile(
      f,
      `reconcile-operational-status-${String(channelOperationalStatus)}`
    );

    assert.equal(result.authorizationReadiness, "READY");
    assert.equal(result.mappingReadiness, "READY");
    assert.equal(result.distributionReadiness, "IN_PROGRESS");
    assert.ok(result.reasons.includes("NO_CONNECTED_CHANNEL_EVIDENCE"));
    assert.equal(f.updates[0].data.status, "DEGRADED");
    assert.equal(f.updates[0].data.activatedAt, null);
    assert.equal(f.updates[0].data.paymentReadiness, "NOT_STARTED");
    assert.equal(f.updates[0].data.taxReadiness, "NOT_STARTED");
    assert.equal(f.updates[0].data.contentReadiness, "NOT_STARTED");
    assert.equal(
      f.audits[0].data.metadata.transportScopePolicy.applied,
      false
    );
  }
});

test("an existing exact Airbnb listing binding remains READY and stable", async () => {
  const f = fixture({
    externalListingId: "airbnb-listing-1",
    status: "ACTIVE",
  });
  const result = await reconcile(f, "reconcile-listing-binding-stable-001");

  assert.equal(result.authorizationReadiness, "READY");
  assert.equal(result.mappingReadiness, "READY");
  assert.equal(result.distributionReadiness, "READY");
  assert.equal(f.updates[0].data.status, "ACTIVE");
  assert.equal(f.updates[0].where.externalListingId, "airbnb-listing-1");
  assert.equal(f.updates[0].data.externalListingId, "airbnb-listing-1");
  assert.equal(
    f.audits[0].data.metadata.resolvedExternalListingId,
    "airbnb-listing-1"
  );
});

test("Airbnb listing drift fails mapping closed without overwriting the canonical binding", async () => {
  const canonicalListingId = "airbnb-listing-existing";
  const f = fixture({
    externalListingId: canonicalListingId,
    channelListingId: "airbnb-listing-drifted",
    status: "ACTIVE",
  });
  const result = await reconcile(f, "reconcile-listing-binding-drift-001");

  assert.notEqual(result.mappingReadiness, "READY");
  assert.notEqual(result.distributionReadiness, "READY");
  assert.ok(result.reasons.includes("CHANNEL_AIRBNB_LISTING_NOT_VERIFIED"));
  assert.ok(result.reasons.includes("CHANNEL_MAPPING_NOT_VERIFIED"));
  assert.equal(f.updates[0].data.status, "DEGRADED");
  assert.equal(f.updates[0].data.activatedAt, null);
  assert.equal(f.updates[0].where.externalListingId, canonicalListingId);
  assert.equal(f.updates[0].data.externalListingId, canonicalListingId);
  assert.equal(
    f.audits[0].data.metadata.resolvedExternalListingId,
    canonicalListingId
  );
  assert.equal(
    f.audits[0].data.metadata.channelVerification.airbnbListingId,
    "airbnb-listing-drifted"
  );
  assert.equal(
    f.audits[0].data.metadata.channelVerification.airbnbListingVerified,
    false
  );
});

test("discovers one unique Airbnb channel and binds it only after exact GET verification", async () => {
  const f = fixture({ externalConnectionId: null, discovery: "UNIQUE" });
  await reconcile(f, "reconcile-discovery-unique-001");

  assert.deepEqual(f.reads.channelCollection, [
    { propertyId: EXTERNAL_PROPERTY_ID, channel: "Airbnb" },
  ]);
  assert.deepEqual(f.reads.channel, [EXTERNAL_CHANNEL_ID]);
  assert.equal(f.updates[0].where.externalConnectionId, null);
  assert.equal(f.updates[0].where.externalChannelCode, null);
  assert.equal(f.updates[0].data.externalConnectionId, EXTERNAL_CHANNEL_ID);
  assert.equal(f.updates[0].data.externalChannelCode, "ABB");
  assert.equal(f.audits[0].data.metadata.channelDiscoveryOutcome, "FOUND");
  assert.equal(f.audits[0].data.metadata.channelCandidateCount, 1);
});

test("ambiguous discovery remains not ready and never binds or exact-reads a candidate", async () => {
  const f = fixture({ externalConnectionId: null, discovery: "AMBIGUOUS" });
  const result = await reconcile(f, "reconcile-discovery-ambiguous-001");

  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_DISCOVERY_AMBIGUOUS"));
  assert.deepEqual(f.reads.channel, []);
  assert.equal(f.updates[0].data.externalConnectionId, null);
  assert.equal(f.updates[0].data.externalChannelCode, null);
  assert.equal(f.updates[0].data.status, "NOT_CONNECTED");
  assert.equal(f.updates[0].data.lastErrorCode, "CHANNEL_DISCOVERY_AMBIGUOUS");
  assert.equal(f.audits[0].data.metadata.channelCandidateCount, 2);
});

test("a stored channel id cannot bypass ambiguous provider discovery", async () => {
  const f = fixture({ discovery: "AMBIGUOUS" });
  const result = await reconcile(f, "reconcile-stored-id-ambiguous-001");

  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_DISCOVERY_AMBIGUOUS"));
  assert.deepEqual(f.reads.channel, []);
  assert.equal(f.updates[0].data.status, "AUTHORIZATION_REQUIRED");
  assert.equal(f.updates[0].data.externalConnectionId, EXTERNAL_CHANNEL_ID);
  assert.equal(f.updates[0].data.lastErrorCode, "CHANNEL_DISCOVERY_AMBIGUOUS");
});

test("an invalid channel collection contract persists negative evidence and degrades ACTIVE", async () => {
  const f = fixture({
    status: "ACTIVE",
    invalidChannelCollectionContract: true,
  });
  const result = await reconcile(
    f,
    "reconcile-channel-collection-contract-invalid-001"
  );

  assert.ok(result.reasons.includes("CHANNEL_COLLECTION_CONTRACT_INVALID"));
  assert.notEqual(result.mappingReadiness, "READY");
  assert.notEqual(result.distributionReadiness, "READY");
  assert.deepEqual(f.reads.channel, []);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].data.status, "DEGRADED");
  assert.equal(f.updates[0].data.activatedAt, null);
  assert.equal(
    f.updates[0].data.lastErrorCode,
    "CHANNEL_COLLECTION_CONTRACT_INVALID"
  );
  assert.equal(f.audits.length, 1);
  assert.ok(
    f.audits[0].data.metadata.reasons.includes(
      "CHANNEL_COLLECTION_CONTRACT_INVALID"
    )
  );
  assert.equal(f.audits[0].data.metadata.channelVerification, null);
});

test("an invalid exact channel contract persists negative evidence and degrades ACTIVE", async () => {
  const f = fixture({
    status: "ACTIVE",
    invalidChannelResourceContract: true,
  });
  const result = await reconcile(
    f,
    "reconcile-channel-resource-contract-invalid-001"
  );

  assert.ok(result.reasons.includes("CHANNEL_RESOURCE_CONTRACT_INVALID"));
  assert.notEqual(result.mappingReadiness, "READY");
  assert.notEqual(result.distributionReadiness, "READY");
  assert.deepEqual(f.reads.channel, [EXTERNAL_CHANNEL_ID]);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].data.status, "DEGRADED");
  assert.equal(f.updates[0].data.activatedAt, null);
  assert.equal(
    f.updates[0].data.lastErrorCode,
    "CHANNEL_RESOURCE_CONTRACT_INVALID"
  );
  assert.equal(f.audits.length, 1);
  assert.ok(
    f.audits[0].data.metadata.reasons.includes(
      "CHANNEL_RESOURCE_CONTRACT_INVALID"
    )
  );
  assert.equal(f.audits[0].data.metadata.channelVerification, null);
});

test("channel JSON parse, 429, and 5xx transport failures propagate without mutation", async (t) => {
  const codes = [
    "OTA_READONLY_PROVIDER_RESPONSE_INVALID",
    "OTA_READONLY_PROVIDER_RATE_LIMITED",
    "OTA_READONLY_PROVIDER_UNAVAILABLE",
  ] as const;
  const phases: ChannelTransportPhase[] = ["COLLECTION", "EXACT"];

  for (const phase of phases) {
    for (const code of codes) {
      await t.test(`${phase}:${code}`, async () => {
        const f = fixture({ channelTransportFailure: { phase, code } });

        await assert.rejects(
          reconcile(
            f,
            `reconcile-channel-transport-${phase.toLowerCase()}-${code.toLowerCase()}`
          ),
          (error: unknown) =>
            error instanceof ChannexReadonlyTransportError &&
            error.code === code
        );
        assert.equal(f.updates.length, 0);
        assert.equal(f.audits.length, 0);
        assert.deepEqual(f.transactionIsolationLevels, []);
      });
    }
  }
});

test("an exact channel 404 degrades an existing ACTIVE connection", async () => {
  const f = fixture({ status: "ACTIVE", channelRead: "NOT_FOUND" });
  const result = await reconcile(f, "reconcile-channel-not-found-001");

  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_EXACT_NOT_FOUND"));
  assert.equal(f.updates[0].data.status, "DEGRADED");
  assert.equal(f.updates[0].data.activatedAt, null);
  assert.equal(f.updates[0].data.lastErrorCode, "CHANNEL_EXACT_NOT_FOUND");
  assert.equal(f.audits[0].data.metadata.canonicalStatus, "DEGRADED");
});

test("an exact Channex group mismatch fails identity and degrades ACTIVE", async () => {
  const f = fixture({ status: "ACTIVE", channelGroupMismatch: true });
  const result = await reconcile(f, "reconcile-channel-group-mismatch-001");

  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_GROUP_NOT_VERIFIED"));
  assert.equal(f.updates[0].data.status, "DEGRADED");
  assert.equal(f.updates[0].data.activatedAt, null);
  assert.equal(f.updates[0].data.lastErrorCode, "CHANNEL_IDENTITY_NOT_VERIFIED");
  assert.equal(f.audits[0].data.metadata.channelVerification.groupVerified, false);
});

test("404 for each exact canonical inventory resource persists fail-closed and degrades ACTIVE", async (t) => {
  const scenarios = [
    {
      resource: "PROPERTY" as const,
      reason: "PROPERTY_NOT_CANONICALLY_VERIFIED",
    },
    {
      resource: "ROOM_TYPE" as const,
      reason: "ROOM_TYPE_NOT_CANONICALLY_VERIFIED",
    },
    {
      resource: "RATE_PLAN" as const,
      reason: "RATE_PLAN_NOT_CANONICALLY_VERIFIED",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.resource, async () => {
      const f = fixture({
        status: "ACTIVE",
        exactReadFailure: {
          resource: scenario.resource,
          code: "OTA_READONLY_RESOURCE_NOT_FOUND",
        },
      });
      const result = await reconcile(
        f,
        `reconcile-${scenario.resource.toLowerCase()}-404-001`
      );

      assert.equal(result.distributionReadiness, "IN_PROGRESS");
      assert.ok(result.reasons.includes(scenario.reason));
      assert.equal(f.updates[0].data.status, "DEGRADED");
      assert.equal(f.updates[0].data.activatedAt, null);
      assert.equal(f.updates.length, 1);
      assert.equal(f.audits.length, 1);
    });
  }
});

test("429 and provider 5xx failures propagate without canonical mutation", async (t) => {
  const scenarios = [
    {
      resource: "PROPERTY" as const,
      code: "OTA_READONLY_PROVIDER_RATE_LIMITED" as const,
    },
    {
      resource: "RATE_PLAN" as const,
      code: "OTA_READONLY_PROVIDER_UNAVAILABLE" as const,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.code, async () => {
      const f = fixture({
        status: "ACTIVE",
        exactReadFailure: scenario,
      });
      await assert.rejects(
        reconcile(f, `reconcile-${scenario.code.toLowerCase()}-001`),
        (error: unknown) =>
          error instanceof ChannexReadonlyTransportError &&
          error.code === scenario.code
      );
      assert.equal(f.updates.length, 0);
      assert.equal(f.audits.length, 0);
      assert.deepEqual(f.transactionIsolationLevels, []);
    });
  }
});

test("DEGRADED re-entry replaces historical activatedAt with the current correlated full sync", async () => {
  const historicalActivatedAt = new Date("2026-08-01T12:00:00.000Z");
  const f = fixture({
    status: "DEGRADED",
    activatedAt: historicalActivatedAt,
  });
  const result = await reconcile(f, "reconcile-degraded-reentry-001");

  assert.equal(result.distributionReadiness, "READY");
  assert.equal(f.updates[0].data.status, "ACTIVE");
  assert.notDeepEqual(
    f.updates[0].data.activatedAt,
    historicalActivatedAt
  );
  assert.deepEqual(f.updates[0].data.activatedAt, FULL_SYNC_COMPLETED_AT);
  assert.deepEqual(
    f.updates[0].data.lastFullSyncConfirmedAt,
    FULL_SYNC_COMPLETED_AT
  );
});

test("a full sync that predates the lifecycle frontier cannot close activation", async () => {
  const f = fixture({ fullSync: "PREDATES_LIFECYCLE" });
  const result = await reconcile(f, "reconcile-stale-full-sync-001");

  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.equal(f.updates[0].data.status, "READINESS_CHECK");
  assert.equal(f.updates[0].data.lastFullSyncConfirmedAt, null);
  assert.equal(f.updates[0].data.lastErrorCode, "OTA_FULL_SYNC_NOT_QUALIFIED");
  assert.ok(
    result.reasons.includes(
      "FULL_SYNC_NOT_QUALIFIED:FULL_SYNC_COMPLETION_PREDATES_FRONTIER"
    )
  );
  assert.equal(f.audits[0].data.metadata.fullSyncEvidence.qualified, false);
  assert.equal(
    f.audits[0].data.metadata.fullSyncEvidence.qualificationReason,
    "FULL_SYNC_COMPLETION_PREDATES_FRONTIER"
  );
});

test("an invalid full-sync timestamp fails closed and cannot activate", async () => {
  const f = fixture({ fullSync: "INVALID_DATE" });
  const result = await reconcile(f, "reconcile-invalid-full-sync-date-001");

  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(
    result.reasons.includes(
      "FULL_SYNC_NOT_QUALIFIED:FULL_SYNC_REQUEST_EVIDENCE_INVALID"
    )
  );
  assert.equal(f.updates[0].data.status, "READINESS_CHECK");
  assert.equal(f.updates[0].data.lastFullSyncConfirmedAt, null);
  assert.equal(f.audits[0].data.metadata.fullSyncEvidence.qualified, false);
});

test("a mapping revision newer than the full-sync request invalidates that sync", async () => {
  const f = fixture({ mappingChangedAfterFullSyncRequest: true });
  const result = await reconcile(f, "reconcile-mapping-revision-001");

  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(
    result.reasons.includes(
      "FULL_SYNC_NOT_QUALIFIED:FULL_SYNC_REQUEST_PREDATES_FRONTIER"
    )
  );
  assert.equal(f.updates[0].data.status, "READINESS_CHECK");
  assert.equal(f.updates[0].data.lastFullSyncConfirmedAt, null);
});

test("full-sync deliveries for a different rate-plan mapping cannot activate", async () => {
  const f = fixture({ outboxMapping: "MISMATCH" });
  const result = await reconcile(f, "reconcile-outbox-mapping-mismatch-001");

  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(
    result.reasons.includes(
      "FULL_SYNC_NOT_QUALIFIED:FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH"
    )
  );
  assert.equal(f.updates[0].data.status, "READINESS_CHECK");
  assert.equal(f.updates[0].data.lastFullSyncConfirmedAt, null);
  assert.equal(
    f.audits[0].data.metadata.fullSyncEvidence.qualificationReason,
    "FULL_SYNC_CORRELATION_PAYLOAD_MISMATCH"
  );
});

test("a mismatched PMS listing prevents ARI mapping attestation and ACTIVE", async () => {
  const f = fixture({ pmsMapping: "MISMATCH" });
  const result = await reconcile(f, "reconcile-pms-mapping-mismatch-001");

  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.equal(f.updates[0].data.status, "MAPPING_REQUIRED");
  assert.equal(f.updates[0].data.paymentReadiness, "NOT_STARTED");
  assert.equal(f.updates[0].data.lastFullSyncConfirmedAt, null);
  assert.equal(
    f.updates[0].data.lastErrorCode,
    "OTA_ARI_CANONICAL_MAPPING_NOT_VERIFIED"
  );
  assert.ok(
    result.reasons.includes(
      "ARI_CANONICAL_MAPPING_NOT_VERIFIED:EXTERNAL_ROOM_TYPE_ID_MISMATCH"
    )
  );
  assert.equal(f.audits[0].data.metadata.ariCanonicalMapping.verified, false);
});

test("deactivate lifecycle stays BLOCKED despite current inventory and mapping", async () => {
  const f = fixture({ lifecycle: "deactivate_channel" });
  const result = await reconcile(f, "reconcile-deactivate-001");

  assert.equal(result.distributionReadiness, "BLOCKED");
  assert.ok(result.reasons.includes("CHANNEL_DEACTIVATED"));
  assert.equal(f.updates[0].data.distributionReadiness, "BLOCKED");
  assert.equal(f.updates[0].data.status, "READINESS_CHECK");
  assert.equal(f.updates[0].data.lastErrorCode, "CHANNEL_DEACTIVATED");
  assert.equal(
    f.updates[0].data.lastErrorSummary,
    "Canonical OTA readiness requires attention: CHANNEL_DEACTIVATED"
  );
});

test("the persistence CAS fences the exact lifecycle watermark and updatedAt", async () => {
  const f = fixture();
  await reconcile(f, "reconcile-cas-watermark-001");

  const where = f.updates[0].where;
  assert.deepEqual(where.updatedAt, UPDATED_AT);
  assert.deepEqual(where.lastLifecycleOccurredAt, LIFECYCLE_OCCURRED_AT);
  assert.equal(
    where.lastLifecycleOccurredAtMicros,
    LIFECYCLE_OCCURRED_AT_MICROS
  );
  assert.equal(where.lastLifecycleEventType, "activate_channel");
  assert.equal(where.lastLifecycleEventPrecedence, 30);
  assert.deepEqual(
    where.channelAuthorizationVerifiedAt,
    LIFECYCLE_OCCURRED_AT
  );
  assert.deepEqual(where.lastChannelActivatedAt, ACTIVATED_AT);
  assert.equal(where.externalListingId, null);
  assert.equal(where.readinessRevision, 0);
  assert.deepEqual(f.updates[0].data.readinessRevision, { increment: 1 });
});

test("a concurrent lifecycle change fails the CAS and writes no audit", async () => {
  const f = fixture({ updateCount: 0 });

  await assert.rejects(
    reconcile(f, "reconcile-cas-conflict-001"),
    (error: unknown) =>
      error instanceof CanonicalOtaReadinessServiceError &&
      error.code === "OTA_CANONICAL_READINESS_STATE_CONFLICT"
  );
  assert.equal(f.updates.length, 3);
  assert.equal(f.audits.length, 0);
  assert.deepEqual(f.transactionIsolationLevels, [
    "Serializable",
    "Serializable",
    "Serializable",
  ]);
});

test("a transactional mutation of internal mapping evidence is fenced before persistence", async () => {
  const f = fixture({ transactionEvidenceMutation: true });

  await assert.rejects(
    reconcile(f, "reconcile-internal-evidence-conflict-001"),
    (error: unknown) =>
      error instanceof CanonicalOtaReadinessServiceError &&
      error.code === "OTA_CANONICAL_INTERNAL_EVIDENCE_CONFLICT"
  );
  assert.equal(f.updates.length, 0);
  assert.equal(f.audits.length, 0);
  assert.deepEqual(f.transactionIsolationLevels, ["Serializable"]);
});

test("same-key replay returns persisted readiness before every Channex GET", async () => {
  const f = fixture({ existingAudit: true });
  const result = await reconcile(f, "reconcile-dedupe-001");

  assert.equal(result.distributionReadiness, "READY");
  assert.deepEqual(result.reasons, ["PERSISTED_WINNER"]);
  assertNoChannexReads(f);
  assert.equal(f.updates.length, 0);
  assert.equal(f.audits.length, 0);
  assert.equal(f.topLevelAuditLookups, 1);
  assert.equal(f.auditLookups, 0);
  assert.deepEqual(f.transactionIsolationLevels, []);
});

test("replay rejects corrupt scope, actor, revision, and historical revision before Channex", async (t) => {
  const scenarios: Array<{
    name: string;
    fixture: FixtureOptions;
  }> = [
    {
      name: "organization scope",
      fixture: {
        existingAudit: true,
        auditRecordOverrides: { organizationId: "other-org" },
      },
    },
    {
      name: "property scope",
      fixture: {
        existingAudit: true,
        auditRecordOverrides: { propertyId: "other-property" },
      },
    },
    {
      name: "entity scope",
      fixture: {
        existingAudit: true,
        auditRecordOverrides: { entityId: "other-connection" },
      },
    },
    {
      name: "engine scope",
      fixture: {
        existingAudit: true,
        auditRecordOverrides: { engine: "OTHER_ENGINE" },
      },
    },
    {
      name: "actor",
      fixture: {
        existingAudit: true,
        auditMetadataOverrides: { requestedByUserId: "other-user" },
      },
    },
    {
      name: "corrupt revision",
      fixture: {
        existingAudit: true,
        auditMetadataOverrides: {
          readinessRevision: { previous: 0, canonical: "1" },
        },
      },
    },
    {
      name: "historical revision",
      fixture: {
        existingAudit: true,
        readinessRevision: 2,
        auditMetadataOverrides: {
          readinessRevision: { previous: 0, canonical: 1 },
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const f = fixture(scenario.fixture);
      await assert.rejects(
        reconcile(f, `replay-invalid-${scenario.name.replaceAll(" ", "-")}`),
        (error: unknown) =>
          error instanceof CanonicalOtaReadinessServiceError &&
          error.code === "OTA_CANONICAL_IDEMPOTENCY_EVIDENCE_INVALID"
      );
      assertNoChannexReads(f);
      assert.equal(f.updates.length, 0);
      assert.equal(f.audits.length, 0);
      assert.deepEqual(f.transactionIsolationLevels, []);
    });
  }
});

test("a concurrent decisionId P2002 retries and returns the persisted winner", async () => {
  const f = fixture({ auditCreateP2002Once: true });
  const result = await reconcile(f, "reconcile-concurrent-dedupe-001");

  assert.equal(result.distributionReadiness, "READY");
  assert.deepEqual(result.reasons, ["PERSISTED_WINNER"]);
  assert.equal(f.auditLookups, 2);
  assert.equal(f.updates.length, 1);
  assert.equal(f.audits.length, 0);
  assert.deepEqual(f.transactionIsolationLevels, [
    "Serializable",
    "Serializable",
  ]);
});

test("a non-decisionId P2002 is not retried and maps to a canonical persistence conflict", async (t) => {
  const phases: NonNullable<FixtureOptions["nonDecisionP2002At"]>[] = [
    "UPDATE",
    "AUDIT_CREATE",
  ];

  for (const nonDecisionP2002At of phases) {
    await t.test(nonDecisionP2002At, async () => {
      const f = fixture({ nonDecisionP2002At });

      await assert.rejects(
        reconcile(
          f,
          `reconcile-non-decision-p2002-${nonDecisionP2002At.toLowerCase()}`
        ),
        (error: unknown) =>
          error instanceof CanonicalOtaReadinessServiceError &&
          error.code === "OTA_CANONICAL_PERSISTENCE_CONFLICT"
      );
      assert.equal(f.updates.length, 1);
      assert.equal(f.audits.length, 0);
      assert.deepEqual(f.transactionIsolationLevels, ["Serializable"]);
    });
  }
});

test("the same connection and request key produce the same decision id", async () => {
  const first = fixture();
  const second = fixture();
  await reconcile(first, "reconcile-repeatable-key");
  await reconcile(second, "reconcile-repeatable-key");

  assert.equal(
    first.audits[0].data.decisionId,
    second.audits[0].data.decisionId
  );
});

test("missing request key fails before provider reads or state mutation", async () => {
  const f = fixture();

  await assert.rejects(
    reconcile(f, ""),
    (error: unknown) =>
      error instanceof CanonicalOtaReadinessServiceError &&
      error.code === "OTA_CANONICAL_REQUEST_KEY_REQUIRED"
  );
  assertNoChannexReads(f);
  assert.equal(f.updates.length, 0);
  assert.equal(f.audits.length, 0);
});

test("requestedByUserId is required before audit lookup or Channex reads", async () => {
  const f = fixture();

  await assert.rejects(
    reconcile(f, "reconcile-missing-actor-001", " "),
    (error: unknown) =>
      error instanceof CanonicalOtaReadinessServiceError &&
      error.code === "OTA_CANONICAL_REQUESTED_BY_USER_ID_REQUIRED"
  );
  assertNoChannexReads(f);
  assert.equal(f.topLevelAuditLookups, 0);
  assert.equal(f.updates.length, 0);
  assert.equal(f.audits.length, 0);
});

test("invalid DistributionGroup scope, readiness, relationship, or external UUID fails before Channex", async (t) => {
  const modes: DistributionGroupMode[] = [
    "MISSING",
    "RELATION_ID_MISMATCH",
    "TENANT_MISMATCH",
    "STATUS_NOT_READY",
    "EXTERNAL_ID_INVALID",
  ];

  for (const mode of modes) {
    await t.test(mode, async () => {
      const f = fixture({ distributionGroup: mode });
      await assert.rejects(
        reconcile(f, `reconcile-invalid-group-${mode.toLowerCase()}`),
        (error: unknown) =>
          error instanceof CanonicalOtaReadinessServiceError &&
          error.code === "OTA_CANONICAL_DISTRIBUTION_GROUP_INVALID"
      );
      assertNoChannexReads(f);
      assert.equal(f.topLevelAuditLookups, 0);
      assert.equal(f.updates.length, 0);
      assert.equal(f.audits.length, 0);
    });
  }
});

test("tenant mismatch fails before Channex, ARI, or persistence work", async () => {
  const f = fixture({ tenantMismatch: true });

  await assert.rejects(
    reconcile(f, "reconcile-tenant-mismatch-001"),
    (error: unknown) =>
      error instanceof CanonicalOtaReadinessServiceError &&
      error.code === "OTA_DISTRIBUTION_TENANT_MISMATCH"
  );
  assertNoChannexReads(f);
  assert.equal(f.updates.length, 0);
  assert.equal(f.audits.length, 0);
});

test("DistributionProperty property identity and tenant drift fail before Channex", async (t) => {
  const relations: NonNullable<
    FixtureOptions["distributionPropertyRelation"]
  >[] = ["PROPERTY_ID_MISMATCH", "PROPERTY_TENANT_MISMATCH"];

  for (const distributionPropertyRelation of relations) {
    await t.test(distributionPropertyRelation, async () => {
      const f = fixture({ distributionPropertyRelation });

      await assert.rejects(
        reconcile(
          f,
          `reconcile-property-relation-${distributionPropertyRelation.toLowerCase()}`
        ),
        (error: unknown) =>
          error instanceof CanonicalOtaReadinessServiceError &&
          error.code === "OTA_DISTRIBUTION_TENANT_MISMATCH"
      );
      assertNoChannexReads(f);
      assert.equal(f.topLevelAuditLookups, 0);
      assert.equal(f.updates.length, 0);
      assert.equal(f.audits.length, 0);
    });
  }
});
