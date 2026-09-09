import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ChannexChannelEvidenceError,
  CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK,
  CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE,
  CHANNEX_CHANNEL_LIFECYCLE_EVENTS,
  applyChannexChannelLifecycleEvidence,
  normalizeChannexChannelLifecycleEvent,
} from "./channex-channel-lifecycle.evidence.js";

const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8"
);
const lifecycleColumnMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260907230000_add_ota_channel_lifecycle_watermark/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const lifecycleConstraintMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260907230100_add_ota_channel_lifecycle_constraints/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const lifecycleValidationMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260907230200_validate_ota_channel_lifecycle_constraints/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const lifecycleMigration = [
  lifecycleColumnMigration,
  lifecycleConstraintMigration,
  lifecycleValidationMigration,
].join("\n");
const externalListingColumnMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260907231000_add_ota_channel_external_listing_binding/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const externalListingValidationMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260907231100_validate_ota_channel_external_listing_constraint/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const externalListingMigration = [
  externalListingColumnMigration,
  externalListingValidationMigration,
].join("\n");
const externalListingIndexMigration = readFileSync(
  new URL(
    "../../prisma/migrations/20260907232000_add_ota_channel_external_listing_unique_index/migration.sql",
    import.meta.url
  ),
  "utf8"
);

const EXTERNAL_PROPERTY_ID = "faf0559d-965f-426c-8303-107b0b1bc5ff";
const EXTERNAL_CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const RECONNECTED_CHANNEL_ID = "22222222-2222-4222-9222-222222222222";
const UNKNOWN_CHANNEL_ID = "33333333-3333-4333-a333-333333333333";
const BOUND_EXTERNAL_LISTING_ID = "airbnb-listing-123";

test("declares the complete Channex channel lifecycle event mask", () => {
  assert.deepEqual(CHANNEX_CHANNEL_LIFECYCLE_EVENTS, [
    "new_channel",
    "updated_channel",
    "activate_channel",
    "deactivate_channel",
    "disconnect_channel",
    "disconnect_listing",
  ]);
  assert.equal(
    CHANNEX_CHANNEL_LIFECYCLE_EVENT_MASK,
    "new_channel;updated_channel;activate_channel;deactivate_channel;disconnect_channel;disconnect_listing"
  );
  assert.deepEqual(CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE, {
    new_channel: 10,
    updated_channel: 20,
    activate_channel: 30,
    deactivate_channel: 40,
    disconnect_listing: 50,
    disconnect_channel: 60,
  });
});

test("persists an additive lifecycle watermark with an all-null or valid tuple constraint", () => {
  for (const field of [
    "lastLifecycleOccurredAt",
    "lastLifecycleOccurredAtMicros",
    "lastLifecycleEventType",
    "lastLifecycleEventPrecedence",
    "channelAuthorizationVerifiedAt",
    "lastChannelActivatedAt",
    "readinessRevision",
  ]) {
    assert.match(schema, new RegExp(`\\b${field}\\b`));
    assert.match(lifecycleMigration, new RegExp(`"${field}"`));
  }
  assert.match(
    lifecycleMigration,
    /"lastLifecycleOccurredAt" IS NULL[\s\S]*"lastLifecycleOccurredAtMicros" IS NULL[\s\S]*"lastLifecycleEventType" IS NULL[\s\S]*"lastLifecycleEventPrecedence" IS NULL[\s\S]*"channelAuthorizationVerifiedAt" IS NULL[\s\S]*"lastChannelActivatedAt" IS NULL/
  );
  assert.match(
    lifecycleMigration,
    /"lastLifecycleOccurredAtMicros" \/ 1000 =[\s\S]*EXTRACT\(EPOCH FROM "lastLifecycleOccurredAt"\)/
  );
  assert.match(
    lifecycleMigration,
    /"lastLifecycleOccurredAt" >= TIMESTAMP '1970-01-01 00:00:00'/
  );
  assert.match(
    lifecycleMigration,
    /"lastLifecycleOccurredAtMicros" >= 0/
  );
  for (const [eventType, precedence] of Object.entries(
    CHANNEX_CHANNEL_LIFECYCLE_EVENT_PRECEDENCE
  )) {
    assert.match(
      lifecycleMigration,
      new RegExp(
        `"lastLifecycleEventType" = '${eventType}' AND "lastLifecycleEventPrecedence" = ${precedence}`
      )
    );
  }
  assert.match(
    lifecycleMigration,
    /"channelAuthorizationVerifiedAt" IS NULL[\s\S]*OR "channelAuthorizationVerifiedAt" <= "lastLifecycleOccurredAt"/
  );
  assert.match(
    lifecycleMigration,
    /"lastChannelActivatedAt" IS NULL[\s\S]*OR "lastChannelActivatedAt" <= "lastLifecycleOccurredAt"/
  );
  assert.match(
    lifecycleMigration,
    /"lastChannelActivatedAt" IS NULL[\s\S]*OR "channelAuthorizationVerifiedAt" IS NOT NULL/
  );
  assert.match(
    lifecycleMigration,
    /"readinessRevision" INTEGER NOT NULL DEFAULT 0/
  );
  assert.match(
    lifecycleMigration,
    /CONSTRAINT "OtaChannelConnection_readiness_revision_check"[\s\S]*CHECK \("readinessRevision" >= 0\)/
  );
  assert.match(lifecycleMigration, /NOT VALID/);
  assert.match(
    lifecycleMigration,
    /VALIDATE CONSTRAINT "OtaChannelConnection_lifecycle_watermark_check"/
  );
  assert.match(lifecycleMigration, /SET LOCAL lock_timeout = '5s'/);
  assert.match(
    schema,
    /externalListingId\s+String\?\s+@db\.VarChar\(255\)/
  );
  assert.match(schema, /@@unique\(\[provider, externalListingId\]\)/);
  assert.match(
    externalListingMigration,
    /ADD COLUMN "externalListingId" VARCHAR\(255\)/
  );
  assert.match(
    externalListingMigration,
    /CONSTRAINT "OtaChannelConnection_external_listing_id_check"[\s\S]*\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,254\}\$/
  );
  assert.match(
    externalListingIndexMigration,
    /CREATE UNIQUE INDEX CONCURRENTLY "OtaChannelConnection_provider_externalListingId_key"[\s\S]*ON "public"\."OtaChannelConnection"\("provider", "externalListingId"\)/
  );
  assert.equal(/\bBEGIN\b|\bCOMMIT\b/i.test(externalListingIndexMigration), false);
  assert.equal(
    /^\s*(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/im.test(
      lifecycleMigration
    ),
    false
  );
  assert.equal(
    /^\s*(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/im.test(
      externalListingMigration
    ),
    false
  );
  assert.equal(
    /^\s*(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/im.test(
      externalListingIndexMigration
    ),
    false
  );
});

test("keeps every retryable transactional migration phase atomic", () => {
  for (const migration of [
    lifecycleColumnMigration,
    lifecycleConstraintMigration,
    lifecycleValidationMigration,
    externalListingColumnMigration,
    externalListingValidationMigration,
  ]) {
    assert.equal((migration.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((migration.match(/^COMMIT;$/gm) ?? []).length, 1);
  }
  assert.equal(/\bBEGIN\b|\bCOMMIT\b/i.test(externalListingIndexMigration), false);
});

function payload(event: string, overrides: Record<string, unknown> = {}) {
  return {
    event,
    timestamp: "2026-09-06T18:00:00.000Z",
    property_id: EXTERNAL_PROPERTY_ID,
    payload: {
      title: "Airbnb certification channel",
      channel_id: EXTERNAL_CHANNEL_ID,
      ota_name: "Airbnb",
    },
    ...overrides,
  };
}

function epochMicros(timestamp: string): bigint {
  const fraction = /\.(\d+)Z$/.exec(timestamp)?.[1] ?? "";
  const microsecondRemainder = BigInt(
    (fraction.padEnd(6, "0").slice(3, 6) || "000")
  );
  return BigInt(new Date(timestamp).getTime()) * 1000n + microsecondRemainder;
}

function client(options: {
  property?: any;
  connection?: any;
  existingAudit?: boolean;
  updateCounts?: number[];
} = {}) {
  const state = {
    updates: [] as any[],
    audits: [] as any[],
    transactionOptions: [] as any[],
  };
  const property = options.property === undefined
    ? { id: "dp-1", organizationId: "org-1", propertyId: "prop-1" }
    : options.property;
  const defaultConnection = {
        id: "conn-1",
        organizationId: "org-1",
        propertyId: "prop-1",
        distributionPropertyId: "dp-1",
        provider: "AIRBNB",
        status: "NOT_CONNECTED",
        externalConnectionId: null,
        externalChannelCode: null,
        externalListingId: null,
        updatedAt: new Date("2026-09-06T17:00:00.000Z"),
        lastLifecycleOccurredAt: null,
        lastLifecycleOccurredAtMicros: null,
        lastLifecycleEventType: null,
        lastLifecycleEventPrecedence: null,
        channelAuthorizationVerifiedAt: null,
        lastChannelActivatedAt: null,
        readinessRevision: 0,
      };
  const connection = options.connection === undefined
    ? defaultConnection
    : options.connection === null
      ? null
      : { ...defaultConnection, ...options.connection };
  const tx = {
    distributionProperty: {
      async findFirst() { return property; },
    },
    otaChannelConnection: {
      async findFirst() { return connection; },
      async updateMany(args: any) {
        state.updates.push(args);
        return {
          count:
            options.updateCounts?.[state.updates.length - 1] ?? 1,
        };
      },
    },
    apmsAuditEntry: {
      async findUnique() { return options.existingAudit ? { id: "audit-1" } : null; },
      async create(args: any) { state.audits.push(args); return { id: "audit-new" }; },
    },
  };
  return {
    state,
    value: {
      async $transaction<T>(
        work: (inner: any) => Promise<T>,
        transactionOptions?: any
      ) {
        state.transactionOptions.push(transactionOptions);
        return work(tx);
      },
    },
  };
}

test("normalizes a complete top-level Airbnb lifecycle envelope", () => {
  const normalized = normalizeChannexChannelLifecycleEvent(payload("new_channel"));
  assert.equal(normalized?.eventType, "new_channel");
  assert.equal(normalized?.provider, "AIRBNB");
  assert.equal(normalized?.externalPropertyId, EXTERNAL_PROPERTY_ID);
  assert.equal(normalized?.externalConnectionId, EXTERNAL_CHANNEL_ID);
  assert.equal(normalized?.externalChannelCode, "ABB");
});

test("normalizes the official activate payload contract", () => {
  const normalized = normalizeChannexChannelLifecycleEvent({
    timestamp: "2026-09-07T18:00:00.000Z",
    user_id: "user-ext",
    payload: {
      title: "Airbnb certification channel",
      channel_id: RECONNECTED_CHANNEL_ID,
      ota_name: "Airbnb",
    },
    property_id: EXTERNAL_PROPERTY_ID,
    event: "activate_channel",
  });
  assert.equal(normalized?.eventType, "activate_channel");
  assert.equal(normalized?.provider, "AIRBNB");
  assert.equal(normalized?.externalPropertyId, EXTERNAL_PROPERTY_ID);
  assert.equal(normalized?.externalConnectionId, RECONNECTED_CHANNEL_ID);
  assert.equal(normalized?.externalChannelCode, "ABB");
  assert.equal(normalized?.occurredAt?.toISOString(), "2026-09-07T18:00:00.000Z");
});

test("normalizes the exact disconnect_channel name with the canonical envelope", () => {
  const normalized = normalizeChannexChannelLifecycleEvent({
    event: "disconnect_channel",
    timestamp: "2026-09-07T18:00:00.000Z",
    property_id: EXTERNAL_PROPERTY_ID,
    payload: { channel_id: EXTERNAL_CHANNEL_ID, ota_name: "Airbnb" },
  });
  assert.equal(normalized?.eventType, "disconnect_channel");
  assert.equal(normalized?.provider, "AIRBNB");
});

test("rejects the undocumented disconnected_channel alias", () => {
  const normalized = normalizeChannexChannelLifecycleEvent(
    payload("disconnected_channel")
  );
  assert.equal(normalized, null);
});

test("does not elevate event or identity aliases outside the canonical envelope", () => {
  const eventAlias = payload("activate_channel") as any;
  delete eventAlias.event;
  eventAlias.event_type = "activate_channel";
  assert.equal(normalizeChannexChannelLifecycleEvent(eventAlias), null);

  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent({
        event: "activate_channel",
        timestamp: "2026-09-07T18:00:00.000000Z",
        property_id: EXTERNAL_PROPERTY_ID,
        payload: { ota_name: "Airbnb" },
        data: { id: "channel-alias-must-not-elevate" },
      }),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_EXTERNAL_CONNECTION_ID_REQUIRED"
  );
});

test("requires the canonical top-level Channex UTC timestamp without aliases", () => {
  const withoutTimestamp = payload("activate_channel");
  delete (withoutTimestamp as any).timestamp;
  assert.throws(
    () => normalizeChannexChannelLifecycleEvent(withoutTimestamp),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_REQUIRED"
  );

  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent({
        ...withoutTimestamp,
        occurred_at: "2026-09-07T18:00:00.000Z",
      }),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_REQUIRED"
  );

  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent(
        payload("activate_channel", { timestamp: "2026-09-07T18:00:00" })
      ),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_INVALID"
  );

  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent(
        payload("activate_channel", { timestamp: "2026-02-30T18:00:00Z" })
      ),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_INVALID"
  );

  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent(
        payload("activate_channel", { timestamp: "2026-09-07T14:00:00-04:00" })
      ),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_INVALID"
  );

  const withMicroseconds = normalizeChannexChannelLifecycleEvent(
    payload("activate_channel", { timestamp: "2026-09-07T18:00:00.123456Z" })
  );
  assert.equal(
    withMicroseconds?.occurredAt.toISOString(),
    "2026-09-07T18:00:00.123Z"
  );
  assert.equal(
    withMicroseconds?.occurredAtMicros,
    epochMicros("2026-09-07T18:00:00.123456Z")
  );

  assert.doesNotThrow(() =>
    normalizeChannexChannelLifecycleEvent(
      payload("activate_channel", { timestamp: "2026-09-07T18:00:00.1234Z" })
    )
  );
  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent(
        payload("activate_channel", { timestamp: "2026-09-07T18:00:00.1234567Z" })
      ),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_INVALID"
  );
});

test("rejects malformed canonical property and channel UUIDs", () => {
  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent(
        payload("activate_channel", { property_id: "not-a-property-uuid" })
      ),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_EXTERNAL_PROPERTY_ID_INVALID"
  );

  assert.throws(
    () =>
      normalizeChannexChannelLifecycleEvent(
        payload("activate_channel", {
          payload: {
            channel_id: "not-a-channel-uuid",
            ota_name: "Airbnb",
          },
        })
      ),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_EXTERNAL_CONNECTION_ID_INVALID"
  );
});

test("canonical payload hashing is stable across object key order", () => {
  const first = normalizeChannexChannelLifecycleEvent({
    event: "activate_channel",
    timestamp: "2026-09-07T18:00:00.000Z",
    property_id: EXTERNAL_PROPERTY_ID,
    payload: {
      channel_id: EXTERNAL_CHANNEL_ID,
      ota_name: "Airbnb",
      settings: { b: 2, a: 1 },
    },
  });
  const second = normalizeChannexChannelLifecycleEvent({
    payload: {
      settings: { a: 1, b: 2 },
      ota_name: "Airbnb",
      channel_id: EXTERNAL_CHANNEL_ID,
    },
    property_id: EXTERNAL_PROPERTY_ID,
    timestamp: "2026-09-07T18:00:00.000Z",
    event: "activate_channel",
  });
  assert.equal(first?.payloadHash, second?.payloadHash);
});

test("does not treat undocumented lifecycle ids as a unique event id", () => {
  const normalized = normalizeChannexChannelLifecycleEvent(
    payload("activate_channel", {
      event_id: "undocumented-event-1",
      webhook_id: "registration-1",
    })
  );
  assert.equal(normalized?.externalEventId, null);
});

test("unknown event is ignored rather than promoted", async () => {
  const { value, state } = client();
  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("some_future_event"),
  });
  assert.deepEqual(result, { ignored: true, ignoredReason: "UNSUPPORTED_EVENT" });
  assert.equal(state.updates.length, 0);
});

test("unknown channel is ignored rather than promoted", async () => {
  const { value, state } = client();
  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("new_channel", {
      payload: {
        title: "Unsupported certification channel",
        channel_id: UNKNOWN_CHANNEL_ID,
        ota_name: "Other",
      },
    }),
  });
  assert.deepEqual(result, { ignored: true, ignoredReason: "UNSUPPORTED_CHANNEL" });
  assert.equal(state.updates.length, 0);
});

test("future lifecycle evidence beyond the accepted clock skew fails before persistence", async () => {
  const { value, state } = client();
  await assert.rejects(
    applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload("activate_channel", {
        timestamp: "2026-09-06T18:05:00.001Z",
      }),
      now: new Date("2026-09-06T18:00:00.000Z"),
    }),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_OCCURRED_AT_FUTURE_SKEW"
  );
  assert.equal(state.transactionOptions.length, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.audits.length, 0);
});

test("new_channel captures identity but never promotes readiness to READY", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") });
  const patch = state.updates[0].data;
  assert.equal(patch.externalConnectionId, EXTERNAL_CHANNEL_ID);
  assert.equal(patch.authorizationReadiness, "IN_PROGRESS");
  assert.equal(patch.mappingReadiness, "NOT_STARTED");
  assert.equal(patch.distributionReadiness, "NOT_STARTED");
  assert.equal(patch.lastLifecycleOccurredAt.toISOString(), "2026-09-06T18:00:00.000Z");
  assert.equal(
    patch.lastLifecycleOccurredAtMicros,
    epochMicros("2026-09-06T18:00:00.000Z")
  );
  assert.equal(patch.lastLifecycleEventType, "new_channel");
  assert.equal(patch.lastLifecycleEventPrecedence, 10);
  assert.equal(patch.channelAuthorizationVerifiedAt, null);
  assert.equal(patch.lastChannelActivatedAt, null);
  assert.deepEqual(patch.readinessRevision, { increment: 1 });
  assert.notEqual(patch.authorizationReadiness, "READY");
  assert.deepEqual(state.transactionOptions, [{ isolationLevel: "Serializable" }]);
  assert.equal(state.updates[0].where.updatedAt.toISOString(), "2026-09-06T17:00:00.000Z");
  assert.equal(state.updates[0].where.lastLifecycleOccurredAt, null);
  assert.equal(state.updates[0].where.lastLifecycleOccurredAtMicros, null);
  assert.equal(state.updates[0].where.lastLifecycleEventType, null);
  assert.equal(state.updates[0].where.lastLifecycleEventPrecedence, null);
  assert.equal(state.updates[0].where.channelAuthorizationVerifiedAt, null);
  assert.equal(state.updates[0].where.lastChannelActivatedAt, null);
  assert.equal(state.updates[0].where.externalListingId, null);
  assert.equal(state.updates[0].where.readinessRevision, 0);
  assert.equal(state.audits[0].data.metadata.previousReadinessRevision, 0);
  assert.equal(state.audits[0].data.metadata.canonicalReadinessRevision, 1);
});

test("activate_channel remains reconciliation-required instead of ACTIVE", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("activate_channel") });
  const patch = state.updates[0].data;
  assert.equal(patch.authorizationReadiness, "IN_PROGRESS");
  assert.equal(patch.mappingReadiness, "IN_PROGRESS");
  assert.equal(patch.distributionReadiness, "IN_PROGRESS");
  assert.equal(
    patch.channelAuthorizationVerifiedAt.toISOString(),
    "2026-09-06T18:00:00.000Z"
  );
  assert.equal(patch.lastChannelActivatedAt.toISOString(), "2026-09-06T18:00:00.000Z");
  assert.equal("status" in patch, false);
});

test("authorization verification is distinct from current activation evidence", async () => {
  const verifiedAt = new Date("2026-09-06T17:00:00.000Z");
  const priorActivation = {
    externalConnectionId: EXTERNAL_CHANNEL_ID,
    externalChannelCode: "ABB",
    lastLifecycleOccurredAt: verifiedAt,
    lastLifecycleOccurredAtMicros: epochMicros(verifiedAt.toISOString()),
    lastLifecycleEventType: "activate_channel",
    lastLifecycleEventPrecedence: 30,
    channelAuthorizationVerifiedAt: verifiedAt,
    lastChannelActivatedAt: verifiedAt,
    readinessRevision: 7,
  };

  const updated = client({ connection: priorActivation });
  await applyChannexChannelLifecycleEvidence({
    client: updated.value,
    payload: payload("updated_channel"),
  });
  assert.equal(
    "channelAuthorizationVerifiedAt" in updated.state.updates[0].data,
    false
  );
  assert.equal("lastChannelActivatedAt" in updated.state.updates[0].data, false);
  assert.equal(
    updated.state.updates[0].where.channelAuthorizationVerifiedAt.toISOString(),
    verifiedAt.toISOString()
  );
  assert.equal(
    updated.state.updates[0].where.lastChannelActivatedAt.toISOString(),
    verifiedAt.toISOString()
  );

  for (const eventType of ["deactivate_channel", "disconnect_listing"]) {
    const negative = client({ connection: priorActivation });
    await applyChannexChannelLifecycleEvidence({
      client: negative.value,
      payload: payload(eventType),
    });
    assert.equal(
      "channelAuthorizationVerifiedAt" in negative.state.updates[0].data,
      false,
      eventType
    );
    assert.equal(negative.state.updates[0].data.lastChannelActivatedAt, null);
  }

  for (const eventType of ["new_channel", "disconnect_channel"]) {
    const reset = client({ connection: priorActivation });
    await applyChannexChannelLifecycleEvidence({
      client: reset.value,
      payload: payload(eventType),
    });
    assert.equal(reset.state.updates[0].data.channelAuthorizationVerifiedAt, null);
    assert.equal(reset.state.updates[0].data.lastChannelActivatedAt, null);
  }
});

test("all non-disconnect lifecycle evidence explicitly degrades an ACTIVE connection", async () => {
  for (const eventType of [
    "new_channel",
    "updated_channel",
    "activate_channel",
    "deactivate_channel",
    "disconnect_listing",
  ]) {
    const { value, state } = client({ connection: { status: "ACTIVE" } });
    await applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload(eventType),
    });
    assert.equal(state.updates[0].data.status, "DEGRADED", eventType);
    if (eventType === "updated_channel") {
      assert.equal("lastChannelActivatedAt" in state.updates[0].data, false);
    } else if (eventType === "activate_channel") {
      assert.equal(
        state.updates[0].data.lastChannelActivatedAt.toISOString(),
        "2026-09-06T18:00:00.000Z"
      );
    } else {
      assert.equal(state.updates[0].data.lastChannelActivatedAt, null);
    }
  }
});

test("deactivate_channel blocks distribution fail-closed", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("deactivate_channel") });
  assert.equal(state.updates[0].data.distributionReadiness, "BLOCKED");
  assert.equal(state.updates[0].data.lastErrorCode, "OTA_CHANNEL_DEACTIVATED");
});

test("disconnect_listing blocks mapping and distribution", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("disconnect_listing") });
  assert.equal(state.updates[0].data.mappingReadiness, "BLOCKED");
  assert.equal(state.updates[0].data.distributionReadiness, "BLOCKED");
});

test("disconnect_channel records a definitive disconnected fail-closed state", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("disconnect_channel"),
    now: new Date("2026-09-08T12:00:00.000Z"),
  });
  const patch = state.updates[0].data;
  assert.equal(patch.status, "DISCONNECTED");
  assert.equal(patch.authorizationReadiness, "REQUIRED");
  assert.equal(patch.mappingReadiness, "BLOCKED");
  assert.equal(patch.distributionReadiness, "BLOCKED");
  assert.equal(patch.disconnectedAt.toISOString(), "2026-09-06T18:00:00.000Z");
  assert.equal(patch.channelAuthorizationVerifiedAt, null);
  assert.equal(patch.lastChannelActivatedAt, null);
});

test("every accepted lifecycle event invalidates full-sync and commercial readiness", async () => {
  for (const eventType of CHANNEX_CHANNEL_LIFECYCLE_EVENTS) {
    const { value, state } = client();
    await applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload(eventType),
    });
    const patch = state.updates[0].data;
    assert.equal(patch.lastFullSyncConfirmedAt, null, eventType);
    assert.equal(patch.paymentReadiness, "NOT_STARTED", eventType);
    assert.equal(patch.taxReadiness, "NOT_STARTED", eventType);
    assert.equal(patch.contentReadiness, "NOT_STARTED", eventType);
  }
});

test("lifecycle evidence fences and invalidates the external listing binding by event semantics", async () => {
  for (const eventType of [
    "new_channel",
    "disconnect_listing",
    "disconnect_channel",
  ]) {
    const { value, state } = client({
      connection: { externalListingId: BOUND_EXTERNAL_LISTING_ID },
    });
    await applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload(eventType),
    });
    assert.equal(
      state.updates[0].where.externalListingId,
      BOUND_EXTERNAL_LISTING_ID,
      eventType
    );
    assert.equal(state.updates[0].data.externalListingId, null, eventType);
  }

  for (const eventType of [
    "updated_channel",
    "activate_channel",
    "deactivate_channel",
  ]) {
    const { value, state } = client({
      connection: { externalListingId: BOUND_EXTERNAL_LISTING_ID },
    });
    await applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload(eventType),
    });
    assert.equal(
      state.updates[0].where.externalListingId,
      BOUND_EXTERNAL_LISTING_ID,
      eventType
    );
    assert.equal("externalListingId" in state.updates[0].data, false, eventType);
  }
});

test("new_channel can start a new authorization cycle after a definitive disconnect", async () => {
  const disconnectedAt = new Date("2026-09-06T17:00:00.000Z");
  const { value, state } = client({
    connection: {
      status: "DISCONNECTED",
      externalConnectionId: EXTERNAL_CHANNEL_ID,
      externalChannelCode: "ABB",
      externalListingId: BOUND_EXTERNAL_LISTING_ID,
      disconnectedAt,
      lastLifecycleOccurredAt: disconnectedAt,
      lastLifecycleOccurredAtMicros: epochMicros(disconnectedAt.toISOString()),
      lastLifecycleEventType: "disconnect_channel",
      lastLifecycleEventPrecedence: 60,
      channelAuthorizationVerifiedAt: null,
      lastChannelActivatedAt: null,
      readinessRevision: 7,
    },
  });

  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("new_channel", {
      payload: {
        title: "Reconnected Airbnb certification channel",
        channel_id: RECONNECTED_CHANNEL_ID,
        ota_name: "Airbnb",
      },
    }),
  });

  assert.equal(result.ignored, false);
  const update = state.updates[0];
  assert.equal(update.where.status, "DISCONNECTED");
  assert.equal(update.where.externalConnectionId, EXTERNAL_CHANNEL_ID);
  assert.equal(update.where.externalChannelCode, "ABB");
  assert.equal(update.where.externalListingId, BOUND_EXTERNAL_LISTING_ID);
  assert.equal(update.where.readinessRevision, 7);
  assert.equal(update.data.externalConnectionId, RECONNECTED_CHANNEL_ID);
  assert.equal(update.data.status, "AUTHORIZATION_REQUIRED");
  assert.equal(update.data.authorizationReadiness, "IN_PROGRESS");
  assert.equal(update.data.mappingReadiness, "NOT_STARTED");
  assert.equal(update.data.distributionReadiness, "NOT_STARTED");
  assert.equal(update.data.activationRequestedAt, null);
  assert.equal(update.data.activatedAt, null);
  assert.equal(update.data.disconnectedAt, null);
  assert.equal(update.data.externalListingId, null);
  assert.equal(update.data.channelAuthorizationVerifiedAt, null);
  assert.equal(update.data.lastChannelActivatedAt, null);
  assert.equal(update.data.lastFullSyncConfirmedAt, null);
  assert.deepEqual(update.data.readinessRevision, { increment: 1 });
  assert.equal(state.audits[0].data.metadata.previousReadinessRevision, 7);
  assert.equal(state.audits[0].data.metadata.canonicalReadinessRevision, 8);
});

test("duplicate evidence is idempotent", async () => {
  const { value, state } = client({ existingAudit: true });
  const result = await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") });
  assert.deepEqual(result, {
    ignored: true,
    ignoredReason: "DUPLICATE_LIFECYCLE_EVENT",
    deduped: true,
    connectionId: "conn-1",
    eventType: "new_channel",
  });
  assert.equal(state.updates.length, 0);
  assert.equal(state.audits.length, 0);
});

test("decision identity is namespaced to the prepared connection", async () => {
  const first = client({ connection: { id: "conn-1" } });
  const second = client({ connection: { id: "conn-2" } });
  await applyChannexChannelLifecycleEvidence({
    client: first.value,
    payload: payload("new_channel"),
  });
  await applyChannexChannelLifecycleEvidence({
    client: second.value,
    payload: payload("new_channel"),
  });
  assert.notEqual(
    first.state.audits[0].data.decisionId,
    second.state.audits[0].data.decisionId
  );
});

test("older lifecycle evidence is durably audited but never mutates state", async () => {
  const { value, state } = client({
    connection: {
      lastLifecycleOccurredAt: new Date("2026-09-06T19:00:00.000Z"),
      lastLifecycleOccurredAtMicros: epochMicros("2026-09-06T19:00:00.000Z"),
      lastLifecycleEventType: "deactivate_channel",
      lastLifecycleEventPrecedence: 40,
    },
  });
  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("activate_channel"),
  });
  assert.equal(result.ignored, true);
  assert.equal(result.ignoredReason, "STALE_LIFECYCLE_EVENT");
  assert.equal(state.updates.length, 0);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].data.eventType, "DECISION_SKIPPED");
  assert.equal(
    state.audits[0].data.summary,
    "Stale Channex OTA channel lifecycle evidence ignored"
  );
  assert.equal(
    state.audits[0].data.metadata.persistedEventType,
    "deactivate_channel"
  );
});

test("equal source timestamps use deterministic fail-closed precedence", async () => {
  const higher = client({
    connection: {
      lastLifecycleOccurredAt: new Date("2026-09-06T18:00:00.000Z"),
      lastLifecycleOccurredAtMicros: epochMicros("2026-09-06T18:00:00.000Z"),
      lastLifecycleEventType: "activate_channel",
      lastLifecycleEventPrecedence: 30,
      channelAuthorizationVerifiedAt: new Date("2026-09-06T18:00:00.000Z"),
      lastChannelActivatedAt: new Date("2026-09-06T18:00:00.000Z"),
    },
  });
  const applied = await applyChannexChannelLifecycleEvidence({
    client: higher.value,
    payload: payload("deactivate_channel"),
  });
  assert.equal(applied.ignored, false);
  assert.equal(higher.state.updates[0].data.lastLifecycleEventPrecedence, 40);
  assert.equal(higher.state.updates[0].data.distributionReadiness, "BLOCKED");
  assert.equal(higher.state.updates[0].data.lastChannelActivatedAt, null);

  const lower = client({
    connection: {
      lastLifecycleOccurredAt: new Date("2026-09-06T18:00:00.000Z"),
      lastLifecycleOccurredAtMicros: epochMicros("2026-09-06T18:00:00.000Z"),
      lastLifecycleEventType: "deactivate_channel",
      lastLifecycleEventPrecedence: 40,
    },
  });
  const ignored = await applyChannexChannelLifecycleEvidence({
    client: lower.value,
    payload: payload("activate_channel"),
  });
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.ignoredReason, "STALE_LIFECYCLE_EVENT");
  assert.equal(lower.state.updates.length, 0);
});

test("a newer source timestamp advances even with a lower event precedence", async () => {
  const { value, state } = client({
    connection: {
      lastLifecycleOccurredAt: new Date("2026-09-06T17:00:00.000Z"),
      lastLifecycleOccurredAtMicros: epochMicros("2026-09-06T17:00:00.000Z"),
      lastLifecycleEventType: "disconnect_channel",
      lastLifecycleEventPrecedence: 60,
    },
  });
  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("new_channel"),
  });
  assert.equal(result.ignored, false);
  assert.equal(state.updates[0].data.lastLifecycleEventType, "new_channel");
  assert.equal(state.updates[0].data.lastLifecycleEventPrecedence, 10);
});

test("microsecond ordering is preserved for events inside the same millisecond", async () => {
  const olderTimestamp = "2026-09-06T18:00:00.123456Z";
  const newerTimestamp = "2026-09-06T18:00:00.123457Z";
  const older = normalizeChannexChannelLifecycleEvent(
    payload("disconnect_channel", { timestamp: olderTimestamp })
  )!;
  const newer = normalizeChannexChannelLifecycleEvent(
    payload("new_channel", { timestamp: newerTimestamp })
  )!;
  assert.equal(older.occurredAt.getTime(), newer.occurredAt.getTime());
  assert.equal(newer.occurredAtMicros - older.occurredAtMicros, 1n);

  const advancing = client({
    connection: {
      lastLifecycleOccurredAt: older.occurredAt,
      lastLifecycleOccurredAtMicros: older.occurredAtMicros,
      lastLifecycleEventType: "disconnect_channel",
      lastLifecycleEventPrecedence: 60,
    },
  });
  const applied = await applyChannexChannelLifecycleEvidence({
    client: advancing.value,
    payload: payload("new_channel", { timestamp: newerTimestamp }),
  });
  assert.equal(applied.ignored, false);
  assert.equal(
    advancing.state.updates[0].data.lastLifecycleOccurredAtMicros,
    newer.occurredAtMicros
  );

  const rejecting = client({
    connection: {
      lastLifecycleOccurredAt: newer.occurredAt,
      lastLifecycleOccurredAtMicros: newer.occurredAtMicros,
      lastLifecycleEventType: "new_channel",
      lastLifecycleEventPrecedence: 10,
    },
  });
  const ignored = await applyChannexChannelLifecycleEvidence({
    client: rejecting.value,
    payload: payload("disconnect_channel", { timestamp: olderTimestamp }),
  });
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.ignoredReason, "STALE_LIFECYCLE_EVENT");
  assert.equal(rejecting.state.updates.length, 0);
});

test("a corrupt partial or mismatched persisted watermark fails closed", async () => {
  for (const connection of [
    { lastLifecycleOccurredAt: new Date("2026-09-06T17:00:00.000Z") },
    { channelAuthorizationVerifiedAt: new Date("2026-09-06T17:00:00.000Z") },
    {
      lastLifecycleOccurredAt: new Date("2026-09-06T17:00:00.000Z"),
      lastLifecycleOccurredAtMicros: epochMicros("2026-09-06T17:00:00.000Z"),
      lastLifecycleEventType: "activate_channel",
      lastLifecycleEventPrecedence: 60,
    },
    {
      lastLifecycleOccurredAt: new Date("2026-09-06T17:00:00.000Z"),
      lastLifecycleOccurredAtMicros: epochMicros("2026-09-06T17:00:00.000Z"),
      lastLifecycleEventType: "activate_channel",
      lastLifecycleEventPrecedence: 30,
      channelAuthorizationVerifiedAt: new Date("2026-09-06T17:00:00.001Z"),
    },
  ]) {
    const { value } = client({ connection });
    await assert.rejects(
      applyChannexChannelLifecycleEvidence({
        client: value,
        payload: payload("activate_channel"),
      }),
      (error: unknown) =>
        error instanceof ChannexChannelEvidenceError &&
        error.code === "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
    );
  }
});

test("a persisted lifecycle watermark with negative epoch micros fails closed", async () => {
  const { value, state } = client({
    connection: {
      lastLifecycleOccurredAt: new Date("1970-01-01T00:00:00.000Z"),
      lastLifecycleOccurredAtMicros: -1n,
      lastLifecycleEventType: "activate_channel",
      lastLifecycleEventPrecedence: 30,
    },
  });

  await assert.rejects(
    applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload("activate_channel"),
    }),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
  );
  assert.equal(state.updates.length, 0);
  assert.equal(state.audits.length, 0);
});

test("persisted activation evidence without authorization verification fails closed", async () => {
  const occurredAt = new Date("2026-09-06T17:00:00.000Z");
  const { value, state } = client({
    connection: {
      lastLifecycleOccurredAt: occurredAt,
      lastLifecycleOccurredAtMicros: epochMicros(occurredAt.toISOString()),
      lastLifecycleEventType: "activate_channel",
      lastLifecycleEventPrecedence: 30,
      channelAuthorizationVerifiedAt: null,
      lastChannelActivatedAt: occurredAt,
    },
  });

  await assert.rejects(
    applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload("activate_channel"),
    }),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_LIFECYCLE_WATERMARK_INVALID"
  );
  assert.equal(state.updates.length, 0);
  assert.equal(state.audits.length, 0);
});

test("a corrupt persisted readiness revision fails closed", async () => {
  for (const readinessRevision of [-1, 1.5, Number.NaN]) {
    const { value, state } = client({ connection: { readinessRevision } });
    await assert.rejects(
      applyChannexChannelLifecycleEvidence({
        client: value,
        payload: payload("activate_channel"),
      }),
      (error: unknown) =>
        error instanceof ChannexChannelEvidenceError &&
        error.code === "OTA_CHANNEL_READINESS_REVISION_INVALID"
    );
    assert.equal(state.updates.length, 0);
    assert.equal(state.audits.length, 0);
  }
});

test("a CAS miss is retried in a fresh serializable transaction", async () => {
  const { value, state } = client({ updateCounts: [0, 1] });
  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("activate_channel"),
  });
  assert.equal(result.ignored, false);
  assert.equal(state.updates.length, 2);
  assert.deepEqual(state.transactionOptions, [
    { isolationLevel: "Serializable" },
    { isolationLevel: "Serializable" },
  ]);
  assert.equal(state.audits.length, 1);
});

test("a concurrent duplicate audit conflict is retried and acknowledged as deduped", async () => {
  let transactionCalls = 0;
  let auditCreates = 0;
  const connection = {
    id: "conn-1",
    organizationId: "org-1",
    propertyId: "prop-1",
    distributionPropertyId: "dp-1",
    provider: "AIRBNB",
    status: "NOT_CONNECTED",
    externalConnectionId: null,
    externalChannelCode: null,
    externalListingId: null,
    updatedAt: new Date("2026-09-06T17:00:00.000Z"),
    lastLifecycleOccurredAt: null,
    lastLifecycleOccurredAtMicros: null,
    lastLifecycleEventType: null,
    lastLifecycleEventPrecedence: null,
    channelAuthorizationVerifiedAt: null,
    lastChannelActivatedAt: null,
    readinessRevision: 0,
  };
  const value = {
    async $transaction<T>(work: (tx: any) => Promise<T>) {
      transactionCalls += 1;
      return work({
        distributionProperty: {
          async findFirst() {
            return { id: "dp-1", organizationId: "org-1", propertyId: "prop-1" };
          },
        },
        otaChannelConnection: {
          async findFirst() { return connection; },
          async updateMany() { return { count: 1 }; },
        },
        apmsAuditEntry: {
          async findUnique() {
            return transactionCalls > 1 ? { id: "concurrent-audit" } : null;
          },
          async create() {
            auditCreates += 1;
            throw Object.assign(new Error("unique constraint"), {
              code: "P2002",
              meta: { target: ["decisionId"] },
            });
          },
        },
      });
    },
  };
  const result = await applyChannexChannelLifecycleEvidence({
    client: value,
    payload: payload("new_channel"),
  });
  assert.equal(result.deduped, true);
  assert.equal(transactionCalls, 2);
  assert.equal(auditCreates, 1);
});

test("exhausted CAS retries fail closed with the public state conflict code", async () => {
  const { value, state } = client({ updateCounts: [0, 0, 0] });
  await assert.rejects(
    applyChannexChannelLifecycleEvidence({
      client: value,
      payload: payload("activate_channel"),
    }),
    (error: unknown) =>
      error instanceof ChannexChannelEvidenceError &&
      error.code === "OTA_CHANNEL_EVIDENCE_STATE_CONFLICT"
  );
  assert.equal(state.transactionOptions.length, 3);
  assert.equal(state.audits.length, 0);
});

test("missing distribution property mapping fails closed", async () => {
  const { value } = client({ property: null });
  await assert.rejects(
    applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") }),
    (error: unknown) => error instanceof ChannexChannelEvidenceError && error.code === "OTA_CHANNEL_PROPERTY_MAPPING_NOT_FOUND"
  );
});

test("tenant mismatch is rejected", async () => {
  const { value } = client({
    connection: {
      id: "conn-1",
      organizationId: "wrong-org",
      propertyId: "prop-1",
      distributionPropertyId: "dp-1",
      provider: "AIRBNB",
      externalConnectionId: null,
    },
  });
  await assert.rejects(
    applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") }),
    (error: unknown) => error instanceof ChannexChannelEvidenceError && error.code === "OTA_DISTRIBUTION_TENANT_MISMATCH"
  );
});

test("conflicting external connection id is rejected", async () => {
  const { value } = client({
    connection: {
      id: "conn-1",
      organizationId: "org-1",
      propertyId: "prop-1",
      distributionPropertyId: "dp-1",
      provider: "AIRBNB",
      externalConnectionId: RECONNECTED_CHANNEL_ID,
    },
  });
  await assert.rejects(
    applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") }),
    (error: unknown) => error instanceof ChannexChannelEvidenceError && error.code === "OTA_CHANNEL_EXTERNAL_CONNECTION_CONFLICT"
  );
});

test("missing external property id is invalid payload evidence", () => {
  assert.throws(
    () => normalizeChannexChannelLifecycleEvent({ event: "new_channel", data: { id: "channel" } }),
    (error: unknown) => error instanceof ChannexChannelEvidenceError && error.code === "OTA_CHANNEL_EXTERNAL_PROPERTY_ID_REQUIRED"
  );
});
