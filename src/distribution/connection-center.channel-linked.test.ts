import assert from "node:assert/strict";
import test from "node:test";

import { buildConnectionCenterReadModel } from "./connection-center.read-model.js";

const baseChannel = {
  provider: "AIRBNB" as const,
  status: "NOT_CONNECTED" as const,
  authorizationReadiness: "REQUIRED" as const,
  mappingReadiness: "NOT_STARTED" as const,
  distributionReadiness: "NOT_STARTED" as const,
  paymentReadiness: "NOT_STARTED" as const,
  taxReadiness: "NOT_STARTED" as const,
  contentReadiness: "NOT_STARTED" as const,
  lastReadinessCheckedAt: null,
  lastFullSyncConfirmedAt: null,
  activatedAt: null,
  lastErrorCode: null,
};

test("persisted external channel reference is exposed without promoting lifecycle status", () => {
  const result = buildConnectionCenterReadModel({
    property: { id: "property-1", name: "Casa Collores" },
    distributionProperty: {
      provisioningStatus: "READY",
      channels: [{
        ...baseChannel,
        externalConnectionId: "716305c4-561a-4561-a187-7f5b8aeb5920",
      }],
    },
  });
  const airbnb = result.channels.find((channel) => channel.provider === "AIRBNB");
  assert.equal(airbnb?.channelLinked, true);
  assert.equal(airbnb?.status, "NOT_CONNECTED");
  assert.equal(airbnb?.nextAction, "CONNECT");
  assert.equal(airbnb?.readiness.authorization, "REQUIRED");
  assert.equal(airbnb?.activatedAt, null);
});

test("missing external channel reference remains unlinked", () => {
  const result = buildConnectionCenterReadModel({
    property: { id: "property-1", name: "Casa Collores" },
    distributionProperty: {
      provisioningStatus: "READY",
      channels: [{ ...baseChannel, externalConnectionId: null }],
    },
  });
  const airbnb = result.channels.find((channel) => channel.provider === "AIRBNB");
  assert.equal(airbnb?.channelLinked, false);
  assert.equal(airbnb?.status, "NOT_CONNECTED");
});
