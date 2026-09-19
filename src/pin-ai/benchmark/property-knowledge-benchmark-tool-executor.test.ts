import assert from "node:assert/strict";
import test from "node:test";

import { scenarios001To010 } from "./scenarios-001-010.js";
import { PropertyKnowledgeBenchmarkToolExecutor } from "./property-knowledge-benchmark-tool-executor.js";

test("benchmark get_property_knowledge uses the real Property Knowledge composer", async () => {
  const scenario = scenarios001To010.find((item) => item.id === "004");
  assert.ok(scenario);

  const executor = new PropertyKnowledgeBenchmarkToolExecutor(
    {
      id: scenario.context.propertyId,
      organizationId: scenario.context.organizationId,
      name: "Benchmark Property",
      publicTitle: "Benchmark Stay",
      publicDescription: "Guest-facing benchmark property.",
      publicDescriptionEs: "Propiedad benchmark para huéspedes.",
      maxGuests: 4,
      timezone: "America/Puerto_Rico",
      checkInTime: "16:00",
      checkOutTime: "11:00",
      guestAccessMode: "PASSCODE_ONLY",
      amenities: [],
      locks: [
        {
          displayName: "Front Door",
          locationLabel: "Main entrance",
          ttlockLockName: "Benchmark Front",
        },
      ],
      propertyDevices: [],
      guestAgreements: [],
      cancellationPolicies: [],
    },
    {
      get_access_status: {
        accessStatus: "ACTIVE",
      },
    },
  );

  const result = await executor.execute("get_property_knowledge", {}, scenario);

  assert.equal(result.organizationId, scenario.context.organizationId);
  assert.equal(result.propertyId, scenario.context.propertyId);
  assert.equal(result.scenarioId, "004");

  const serialized = JSON.stringify(result);
  assert.match(serialized, /Front Door/);
  assert.match(serialized, /Main entrance/);
  assert.doesNotMatch(serialized, /ttlockLockId/);
  assert.doesNotMatch(serialized, /activePasscode/);
});

test("benchmark non-property tools still use fail-closed fixtures", async () => {
  const scenario = scenarios001To010.find((item) => item.id === "004");
  assert.ok(scenario);

  const executor = new PropertyKnowledgeBenchmarkToolExecutor({
    id: scenario.context.propertyId,
    organizationId: scenario.context.organizationId,
    name: "Benchmark Property",
    publicTitle: null,
    publicDescription: null,
    publicDescriptionEs: null,
    maxGuests: 4,
    timezone: "America/Puerto_Rico",
    checkInTime: "16:00",
    checkOutTime: "11:00",
    guestAccessMode: "PASSCODE_ONLY",
    amenities: [],
    locks: [],
    propertyDevices: [],
    guestAgreements: [],
    cancellationPolicies: [],
  });

  await assert.rejects(
    executor.execute("get_access_status", {}, scenario),
    /MOCK_TOOL_FIXTURE_MISSING:004:get_access_status/,
  );
});
