import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConnectionCenterReadModel,
  type ConnectionCenterProvider,
  type StoredOtaChannel,
} from "./connection-center.read-model";

function storedChannel(
  provider: ConnectionCenterProvider,
  status: StoredOtaChannel["status"]
): StoredOtaChannel {
  return {
    provider,
    status,
    authorizationReadiness: "READY",
    mappingReadiness: "READY",
    distributionReadiness: "READY",
    paymentReadiness: "NOT_APPLICABLE",
    taxReadiness: "NOT_APPLICABLE",
    contentReadiness: "NOT_APPLICABLE",
    lastReadinessCheckedAt: null,
    lastFullSyncConfirmedAt: null,
    activatedAt: null,
    lastErrorCode: null,
  };
}

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
      channel.evidenceScope,
      channel.downstreamOtaAcceptance,
    ]),
    [
      ["AIRBNB", "NOT_CONNECTED", "AVAILABLE", "NONE", "NONE"],
      ["BOOKING_COM", "NOT_CONNECTED", "AVAILABLE", "NONE", "NONE"],
      ["EXPEDIA", "NOT_CONNECTED", "PLANNED", "NONE", "NONE"],
      ["VRBO", "NOT_CONNECTED", "ASSISTED_BETA", "NONE", "NONE"],
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
  assert.equal(
    result.channels[0]?.evidenceScope,
    "CHANNEL_MANAGER_TECHNICAL"
  );
  assert.equal(result.channels[0]?.downstreamOtaAcceptance, "NOT_ATTESTED");
  assert.equal(result.channels[1]?.evidenceScope, "NONE");
  assert.equal(result.channels[1]?.downstreamOtaAcceptance, "NONE");
});

test("ACTIVE discloses technical channel-manager evidence without claiming OTA acceptance", () => {
  const result = buildConnectionCenterReadModel({
    property: { id: "property-a", name: "Casa A" },
    distributionProperty: {
      provisioningStatus: "READY",
      channels: [
        {
          provider: "AIRBNB",
          status: "ACTIVE",
          authorizationReadiness: "READY",
          mappingReadiness: "READY",
          distributionReadiness: "READY",
          paymentReadiness: "NOT_APPLICABLE",
          taxReadiness: "NOT_APPLICABLE",
          contentReadiness: "NOT_APPLICABLE",
          lastReadinessCheckedAt: new Date("2026-09-07T12:00:00.000Z"),
          lastFullSyncConfirmedAt: new Date("2026-09-07T12:01:00.000Z"),
          activatedAt: new Date("2026-09-07T12:02:00.000Z"),
          lastErrorCode: null,
        },
      ],
    },
  });

  assert.equal(result.status, "ACTIVE");
  assert.equal(result.channels[0]?.status, "ACTIVE");
  assert.equal(
    result.channels[0]?.evidenceScope,
    "CHANNEL_MANAGER_TECHNICAL"
  );
  assert.equal(result.channels[0]?.downstreamOtaAcceptance, "NOT_ATTESTED");
  assert.equal(JSON.stringify(result).toLowerCase().includes("channex"), false);
});

test("property aggregation degrades ACTIVE when another channel failed or is disconnecting", () => {
  for (const [otherStatus, expected] of [
    ["FAILED", "DEGRADED"],
    ["DISCONNECTING", "DEGRADED"],
  ] as const) {
    const result = buildConnectionCenterReadModel({
      property: { id: "property-a", name: "Casa A" },
      distributionProperty: {
        provisioningStatus: "READY",
        channels: [
          storedChannel("AIRBNB", "ACTIVE"),
          storedChannel("BOOKING_COM", otherStatus),
        ],
      },
    });

    assert.equal(result.status, expected);
  }

  const activeOnly = buildConnectionCenterReadModel({
    property: { id: "property-a", name: "Casa A" },
    distributionProperty: {
      provisioningStatus: "READY",
      channels: [storedChannel("AIRBNB", "ACTIVE")],
    },
  });
  assert.equal(activeOnly.status, "ACTIVE");
});
