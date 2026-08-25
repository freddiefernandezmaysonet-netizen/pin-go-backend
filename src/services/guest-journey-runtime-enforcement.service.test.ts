import assert from "node:assert/strict";
import test from "node:test";

import type { GuestJourneyActivationControlPlaneConfig } from "./guest-journey-activation-control-plane.service";
import {
  GUEST_JOURNEY_RUNTIME_ENFORCEMENT_VERSION,
  verifyGuestJourneyRuntimeScope,
  type GuestJourneyRuntimeScopePrisma,
} from "./guest-journey-runtime-enforcement.service";

function activationConfig(input?: {
  profile?: GuestJourneyActivationControlPlaneConfig["profile"];
  organizationIds?: string[];
  propertyIds?: string[];
}): GuestJourneyActivationControlPlaneConfig {
  return {
    version: "guest_journey_activation_control_plane_v1",
    profile: input?.profile ?? "observe",
    enabledStages: [],
    scope: {
      organizationIds: input?.organizationIds ?? ["org-1"],
      propertyIds: input?.propertyIds ?? ["property-1"],
    },
    configs: {} as GuestJourneyActivationControlPlaneConfig["configs"],
  };
}

function prismaMock(input?: {
  organizations?: Array<{ id: string }>;
  properties?: Array<{
    id: string;
    organizationId: string;
  }>;
}) {
  let organizationReads = 0;
  let propertyReads = 0;

  const prisma: GuestJourneyRuntimeScopePrisma = {
    organization: {
      async findMany() {
        organizationReads += 1;
        return input?.organizations ?? [{ id: "org-1" }];
      },
    },
    property: {
      async findMany() {
        propertyReads += 1;
        return (
          input?.properties ?? [
            {
              id: "property-1",
              organizationId: "org-1",
            },
          ]
        );
      },
    },
  };

  return {
    prisma,
    reads: () => ({
      organizationReads,
      propertyReads,
    }),
  };
}

test("E12 remains default-off without reading runtime scope", async () => {
  const mock = prismaMock();
  const result = await verifyGuestJourneyRuntimeScope(
    mock.prisma,
    activationConfig({
      profile: "off",
      organizationIds: [],
      propertyIds: [],
    })
  );

  assert.equal(
    result.version,
    GUEST_JOURNEY_RUNTIME_ENFORCEMENT_VERSION
  );
  assert.equal(result.enforced, false);
  assert.equal(result.reason, "PROFILE_OFF");
  assert.deepEqual(mock.reads(), {
    organizationReads: 0,
    propertyReads: 0,
  });
});

test("E12 verifies configured tenant/property scope read-only", async () => {
  const mock = prismaMock();
  const result = await verifyGuestJourneyRuntimeScope(
    mock.prisma,
    activationConfig()
  );

  assert.equal(result.enforced, true);
  assert.equal(result.reason, "SCOPE_VERIFIED");
  assert.deepEqual(result.organizationIds, ["org-1"]);
  assert.deepEqual(result.propertyIds, ["property-1"]);
  assert.deepEqual(mock.reads(), {
    organizationReads: 1,
    propertyReads: 1,
  });
});

test("E12 fails closed when an activation tenant does not exist", async () => {
  const mock = prismaMock({
    organizations: [],
  });

  await assert.rejects(
    verifyGuestJourneyRuntimeScope(
      mock.prisma,
      activationConfig()
    ),
    /RUNTIME_ORGANIZATION_SCOPE_NOT_FOUND/
  );
});

test("E12 fails closed when an activation property does not exist", async () => {
  const mock = prismaMock({
    properties: [],
  });

  await assert.rejects(
    verifyGuestJourneyRuntimeScope(
      mock.prisma,
      activationConfig()
    ),
    /RUNTIME_PROPERTY_SCOPE_NOT_FOUND/
  );
});

test("E12 fails closed when a property is outside the configured tenant", async () => {
  const mock = prismaMock({
    properties: [
      {
        id: "property-1",
        organizationId: "org-2",
      },
    ],
  });

  await assert.rejects(
    verifyGuestJourneyRuntimeScope(
      mock.prisma,
      activationConfig()
    ),
    /RUNTIME_TENANT_PROPERTY_SCOPE_MISMATCH/
  );
});
