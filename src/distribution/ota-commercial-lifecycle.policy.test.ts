import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDistributionTenantScope,
  assertOtaChannelTransition,
  assessOtaActivationReadiness,
  derivePropertyCommercialDistributionStatus,
  type OtaActivationEvidence,
} from "./ota-commercial-lifecycle.policy";

function readyEvidence(
  overrides: Partial<OtaActivationEvidence> = {}
): OtaActivationEvidence {
  return {
    distributionPropertyStatus: "READY",
    externalConnectionId: "external-channel-1",
    authorizationReadiness: "READY",
    mappingReadiness: "READY",
    distributionReadiness: "READY",
    paymentReadiness: "NOT_APPLICABLE",
    taxReadiness: "READY",
    contentReadiness: "READY",
    lastFullSyncConfirmedAt: new Date("2026-09-05T12:00:00.000Z"),
    ...overrides,
  };
}

test("activation is fail-closed until every required readiness signal exists", () => {
  const result = assessOtaActivationReadiness(
    readyEvidence({
      externalConnectionId: null,
      mappingReadiness: "BLOCKED",
      lastFullSyncConfirmedAt: null,
    })
  );

  assert.equal(result.canActivate, false);
  assert.deepEqual(result.blockers, [
    "EXTERNAL_CONNECTION_ID_MISSING",
    "MAPPING_NOT_READY",
    "FULL_SYNC_NOT_CONFIRMED",
  ]);
});

test("activation accepts READY or NOT_APPLICABLE commercial readiness", () => {
  assert.deepEqual(assessOtaActivationReadiness(readyEvidence()), {
    canActivate: true,
    blockers: [],
  });
});

test("a channel cannot jump directly from not connected to active", () => {
  assert.throws(
    () =>
      assertOtaChannelTransition({
        current: "NOT_CONNECTED",
        next: "ACTIVE",
        activationEvidence: readyEvidence(),
      }),
    /OTA_CHANNEL_TRANSITION_INVALID:NOT_CONNECTED:ACTIVE/
  );
});

test("activation pending cannot become active without confirmed evidence", () => {
  assert.throws(
    () =>
      assertOtaChannelTransition({
        current: "ACTIVATION_PENDING",
        next: "ACTIVE",
        activationEvidence: readyEvidence({ distributionReadiness: "IN_PROGRESS" }),
      }),
    /OTA_CHANNEL_ACTIVATION_BLOCKED:DISTRIBUTION_NOT_READY/
  );

  assert.doesNotThrow(() =>
    assertOtaChannelTransition({
      current: "ACTIVATION_PENDING",
      next: "ACTIVE",
      activationEvidence: readyEvidence(),
    })
  );
});

test("tenant scope rejects any organization mismatch", () => {
  assert.throws(
    () =>
      assertDistributionTenantScope({
        organizationId: "organization-a",
        propertyOrganizationId: "organization-a",
        groupOrganizationId: "organization-b",
        distributionPropertyOrganizationId: "organization-a",
      }),
    /OTA_DISTRIBUTION_TENANT_MISMATCH/
  );
});

test("property status is derived from real channel states", () => {
  assert.equal(derivePropertyCommercialDistributionStatus([]), "NOT_CONFIGURED");
  assert.equal(
    derivePropertyCommercialDistributionStatus(["AUTHORIZATION_REQUIRED"]),
    "SETUP_REQUIRED"
  );
  assert.equal(
    derivePropertyCommercialDistributionStatus(["ACTIVATION_PENDING"]),
    "ACTIVATION_PENDING"
  );
  assert.equal(
    derivePropertyCommercialDistributionStatus(["ACTIVE", "MAPPING_REQUIRED"]),
    "ACTIVE"
  );
  assert.equal(
    derivePropertyCommercialDistributionStatus(["ACTIVE", "DEGRADED"]),
    "DEGRADED"
  );
  assert.equal(derivePropertyCommercialDistributionStatus(["FAILED"]), "FAILED");
});
