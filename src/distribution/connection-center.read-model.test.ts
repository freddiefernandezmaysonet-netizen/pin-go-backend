import assert from "node:assert/strict";
import test from "node:test";

import { buildConnectionCenterReadModel } from "./connection-center.read-model";

test("empty property produces an honest white-label catalog", () => {
  const result = buildConnectionCenterReadModel({
    property: { id: "property-a", name: "Casa A" },
    distributionProperty: null,
  });

  assert.equal(result.productName, "Distribution by Pin&Go");
  assert.equal(result.status, "NOT_CONFIGURED");
  assert.deepEqual(
    result.channels.map((channel) => [
      channel.provider,
      channel.status,
      channel.availability,
    ]),
    [
      ["AIRBNB", "NOT_CONNECTED", "AVAILABLE"],
      ["BOOKING_COM", "NOT_CONNECTED", "AVAILABLE"],
      ["EXPEDIA", "NOT_CONNECTED", "PLANNED"],
      ["VRBO", "NOT_CONNECTED", "ASSISTED_BETA"],
    ]
  );
  assert.equal(JSON.stringify(result).toLowerCase().includes("channex"), false);
});

test("channel status comes from durable channel evidence, not PMS presence", () => {
  const result = buildConnectionCenterReadModel({
    property: { id: "property-a", name: "Casa A" },
    distributionProperty: {
      provisioningStatus: "READY",
      channels: [
        {
          provider: "AIRBNB",
          status: "MAPPING_REQUIRED",
          authorizationReadiness: "READY",
          mappingReadiness: "REQUIRED",
          distributionReadiness: "NOT_STARTED",
          paymentReadiness: "NOT_STARTED",
          taxReadiness: "NOT_STARTED",
          contentReadiness: "NOT_STARTED",
          lastReadinessCheckedAt: null,
          lastFullSyncConfirmedAt: null,
          activatedAt: null,
          lastErrorCode: null,
        },
      ],
    },
  });

  assert.equal(result.status, "SETUP_REQUIRED");
  assert.equal(result.channels[0]?.status, "MAPPING_REQUIRED");
  assert.equal(result.channels[0]?.nextAction, "COMPLETE_MAPPING");
});
