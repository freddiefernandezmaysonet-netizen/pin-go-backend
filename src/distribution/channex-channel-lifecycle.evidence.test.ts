import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannexChannelEvidenceError,
  applyChannexChannelLifecycleEvidence,
  normalizeChannexChannelLifecycleEvent,
} from "./channex-channel-lifecycle.evidence.js";

function payload(event: string, overrides: Record<string, unknown> = {}) {
  return {
    event,
    event_id: `evt-${event}`,
    occurred_at: "2026-09-06T18:00:00.000Z",
    data: {
      id: "channel-ext-1",
      attributes: {
        property_id: "property-ext-1",
        channel: "ABB",
      },
    },
    ...overrides,
  };
}

function client(options: {
  property?: any;
  connection?: any;
  existingAudit?: boolean;
} = {}) {
  const state = {
    updates: [] as any[],
    audits: [] as any[],
  };
  const property = options.property === undefined
    ? { id: "dp-1", organizationId: "org-1", propertyId: "prop-1" }
    : options.property;
  const connection = options.connection === undefined
    ? {
        id: "conn-1",
        organizationId: "org-1",
        propertyId: "prop-1",
        distributionPropertyId: "dp-1",
        provider: "AIRBNB",
        externalConnectionId: null,
      }
    : options.connection;
  const tx = {
    distributionProperty: {
      async findFirst() { return property; },
    },
    otaChannelConnection: {
      async findFirst() { return connection; },
      async updateMany(args: any) {
        state.updates.push(args);
        return { count: 1 };
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
      async $transaction<T>(work: (inner: any) => Promise<T>) { return work(tx); },
    },
  };
}

test("normalizes documented Airbnb channel lifecycle envelope", () => {
  const normalized = normalizeChannexChannelLifecycleEvent(payload("new_channel"));
  assert.equal(normalized?.eventType, "new_channel");
  assert.equal(normalized?.provider, "AIRBNB");
  assert.equal(normalized?.externalPropertyId, "property-ext-1");
  assert.equal(normalized?.externalConnectionId, "channel-ext-1");
  assert.equal(normalized?.externalChannelCode, "ABB");
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
      data: { id: "x", attributes: { property_id: "property-ext-1", channel: "OTHER" } },
    }),
  });
  assert.deepEqual(result, { ignored: true, ignoredReason: "UNSUPPORTED_CHANNEL" });
  assert.equal(state.updates.length, 0);
});

test("new_channel captures identity but never promotes readiness to READY", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") });
  const patch = state.updates[0].data;
  assert.equal(patch.externalConnectionId, "channel-ext-1");
  assert.equal(patch.authorizationReadiness, "IN_PROGRESS");
  assert.equal(patch.mappingReadiness, "NOT_STARTED");
  assert.equal(patch.distributionReadiness, "NOT_STARTED");
  assert.notEqual(patch.authorizationReadiness, "READY");
});

test("activate_channel remains reconciliation-required instead of ACTIVE", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("activate_channel") });
  const patch = state.updates[0].data;
  assert.equal(patch.authorizationReadiness, "IN_PROGRESS");
  assert.equal(patch.mappingReadiness, "IN_PROGRESS");
  assert.equal(patch.distributionReadiness, "IN_PROGRESS");
  assert.equal("status" in patch, false);
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

test("disconnected_channel records a definitive disconnected fail-closed state", async () => {
  const { value, state } = client();
  await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("disconnected_channel") });
  const patch = state.updates[0].data;
  assert.equal(patch.status, "DISCONNECTED");
  assert.equal(patch.authorizationReadiness, "REQUIRED");
  assert.equal(patch.mappingReadiness, "BLOCKED");
  assert.equal(patch.distributionReadiness, "BLOCKED");
});

test("duplicate evidence is idempotent", async () => {
  const { value, state } = client({ existingAudit: true });
  const result = await applyChannexChannelLifecycleEvidence({ client: value, payload: payload("new_channel") });
  assert.equal(result.deduped, true);
  assert.equal(state.updates.length, 0);
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
      externalConnectionId: "different-channel",
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
