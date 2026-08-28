from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative_path: str, old: str, new: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"PATCH_ANCHOR_MISMATCH:{relative_path}:expected=1:actual={count}"
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(relative_path: str, marker: str, block: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    if marker in text:
        raise SystemExit(f"PATCH_ALREADY_PRESENT:{relative_path}:{marker}")
    suffix = "" if text.endswith("\n") else "\n"
    path.write_text(text + suffix + "\n" + block.strip() + "\n", encoding="utf-8")


# E6: Mission Control must not advertise an owner runtime for a property outside
# the configured subset merely because the organization matches.
replace_once(
    "src/services/guest-journey-mission-control-cycle.service.ts",
    '''import {\n  assertGuestJourneyTenantPropertyScope,\n  buildGuestJourneyCoordinationIntentScopeWhere,\n} from "./guest-journey-tenant-property-scope.policy";''',
    '''import {\n  assertGuestJourneyTenantPropertyScope,\n  buildGuestJourneyCoordinationIntentScopeWhere,\n  isGuestJourneyTenantPropertyScope,\n} from "./guest-journey-tenant-property-scope.policy";''',
)

replace_once(
    "src/services/guest-journey-mission-control-cycle.service.ts",
    '''  return (\n    input.ownerRuntimeConfig\n      .organizationIds.includes(\n        input.intent.reservation\n          .property.organizationId\n      ) ||\n    input.ownerRuntimeConfig\n      .propertyIds.includes(\n        input.intent.reservation\n          .propertyId\n      )\n  );''',
    '''  return isGuestJourneyTenantPropertyScope(\n    input.ownerRuntimeConfig,\n    {\n      organizationId:\n        input.intent.reservation.property.organizationId,\n      propertyId:\n        input.intent.reservation.propertyId,\n    }\n  );''',
)

append_once(
    "src/services/guest-journey-mission-control-cycle.service.test.ts",
    "same-tenant intent outside the owner property subset",
    r'''
test("does not mark a same-tenant intent outside the owner property subset as auto-resolving", async () => {
  const outsideSubset = candidate();
  outsideSubset.reservation.propertyId = "property-2";
  const harness = prismaCandidates([
    outsideSubset,
  ]);
  let ownerRuntimeEnabled = true;

  await runGuestJourneyMissionControlCycle(
    harness.prisma as never,
    bridgeConfig({
      propertyIds: ["property-1"],
    }),
    ownerConfig({
      propertyIds: ["property-1"],
    }),
    {
      now: NOW,
      dependencies: {
        sync: async (
          _db,
          _intent,
          options
        ) => {
          ownerRuntimeEnabled =
            options.ownerRuntimeEnabled;
          return {
            lifecycle: "UNCHANGED",
            escalation: "NOT_REQUIRED",
            operationalIssueWrites: 0,
            externalSideEffects: 0,
          };
        },
      },
    }
  );

  assert.equal(
    ownerRuntimeEnabled,
    false
  );
});
''',
)

# E13: runtime applicability is organization-rooted. A property subset narrows
# that organization and can never independently authorize another property.
replace_once(
    "src/services/guest-journey-runtime-state.service.ts",
    '''  return (\n    organizationHashes.includes(\n      hashGuestJourneyRuntimeScopeId("organization", input.organizationId)\n    ) ||\n    propertyHashes.includes(\n      hashGuestJourneyRuntimeScopeId("property", input.propertyId)\n    )\n  );''',
    '''  const organizationMatches =\n    organizationHashes.includes(\n      hashGuestJourneyRuntimeScopeId("organization", input.organizationId)\n    );\n\n  if (!organizationMatches) return false;\n  if (propertyHashes.length === 0) return true;\n\n  return propertyHashes.includes(\n    hashGuestJourneyRuntimeScopeId("property", input.propertyId)\n  );''',
)

replace_once(
    "src/services/guest-journey-runtime-state.service.test.ts",
    r'''test("E13 hashed scope membership supports property and organization canaries", () => {
  const runtime = {
    activationProfile: "shadow_only",
    organizationScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "organization",
        "org-1"
      ),
    ],
    propertyScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "property",
        "property-2"
      ),
    ],
  };

  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      runtime,
      {
        organizationId: "org-1",
        propertyId: "property-1",
      }
    ),
    true
  );
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      runtime,
      {
        organizationId: "org-2",
        propertyId: "property-2",
      }
    ),
    true
  );
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      runtime,
      {
        organizationId: "org-2",
        propertyId: "property-3",
      }
    ),
    false
  );
});''',
    r'''test("E13 hashed scope membership enforces organization and optional property subset", () => {
  const propertySubsetRuntime = {
    activationProfile: "shadow_only",
    organizationScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "organization",
        "org-1"
      ),
    ],
    propertyScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "property",
        "property-2"
      ),
    ],
  };

  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      propertySubsetRuntime,
      {
        organizationId: "org-1",
        propertyId: "property-2",
      }
    ),
    true
  );
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      propertySubsetRuntime,
      {
        organizationId: "org-1",
        propertyId: "property-1",
      }
    ),
    false
  );
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      propertySubsetRuntime,
      {
        organizationId: "org-2",
        propertyId: "property-2",
      }
    ),
    false
  );

  const organizationWideRuntime = {
    ...propertySubsetRuntime,
    propertyScopeHashes: [],
  };
  assert.equal(
    isGuestJourneyRuntimeScopeMatch(
      organizationWideRuntime,
      {
        organizationId: "org-1",
        propertyId: "property-any",
      }
    ),
    true
  );
});''',
)

append_once(
    "src/apms/mission-control-runtime-health.e13.test.ts",
    "same organization but outside the configured property subset",
    r'''
test("E13 treats a same-organization property outside the configured subset as out of scope", () => {
  const result = deriveMissionControlNativeHealth({
    runtimeRows: [
      runtime({
        propertyScopeHashes: [
          hashGuestJourneyRuntimeScopeId(
            "property",
            "property-1"
          ),
        ],
      }),
    ],
    allVisibilityCurrentIssues: [],
    organizationId: "org-1",
    propertyId: "property-2",
    now: NOW,
  });

  assert.equal(
    result.runtimeApplicable,
    false
  );
  assert.equal(
    result.autopilotStatus,
    "PAUSED"
  );
});
''',
)

# Make the dedicated hierarchy suite inspect the two residual boundaries too.
replace_once(
    "src/services/guest-journey-tenant-property-scope.policy.test.ts",
    '''    const ownerConfigs = [\n      "guest-journey-access-owner.config.ts",''',
    r'''    const missionControlCycle = read(
      "./guest-journey-mission-control-cycle.service.ts"
    );
    assert.match(
      missionControlCycle,
      /isGuestJourneyTenantPropertyScope/
    );

    const runtimeState = read(
      "./guest-journey-runtime-state.service.ts"
    );
    assert.match(
      runtimeState,
      /if \(!organizationMatches\) return false/
    );
    assert.match(
      runtimeState,
      /if \(propertyHashes\.length === 0\) return true/
    );
    assert.doesNotMatch(
      runtimeState,
      /organizationHashes\.includes\([\s\S]{0,180}\|\|[\s\S]{0,180}propertyHashes\.includes/
    );

    const ownerConfigs = [
      "guest-journey-access-owner.config.ts",''',
)

# Future PRs touching E13 runtime applicability must trigger the tenant-scope gate.
replace_once(
    ".github/workflows/guest-journey-enterprise-tenant-scope-certification.yml",
    '''      - "src/services/guest-journey-*-runtime.service*"\n      - "src/workers/reservation.worker.ts"''',
    '''      - "src/services/guest-journey-*-runtime.service*"\n      - "src/services/guest-journey-runtime-state.service*"\n      - "src/apms/mission-control-runtime-health.e13*"\n      - "src/workers/reservation.worker.ts"''',
)

print("APMS_HIERARCHICAL_SCOPE_RESIDUAL_PATCH_APPLIED")
