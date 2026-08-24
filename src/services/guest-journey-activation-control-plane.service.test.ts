import assert from "node:assert/strict";
import test from "node:test";

import {
  GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_VERSION,
  GUEST_JOURNEY_ACTIVATION_PROFILES,
  resolveGuestJourneyActivationControlPlaneConfig,
} from "./guest-journey-activation-control-plane.service";

const ORG_SCOPE = "org-1";
const PROPERTY_SCOPE = "property-1";

function scopedEnv(): NodeJS.ProcessEnv {
  return {
    GUEST_JOURNEY_SHADOW_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_SHADOW_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_INTERNAL_RECONCILE_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_INTERNAL_RECONCILE_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_COORDINATION_INTENTS_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_COORDINATION_INTENTS_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_OWNER_RUNTIME_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_OWNER_RUNTIME_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_COMMUNICATIONS_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_COMMUNICATIONS_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_ACCESS_OWNER_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_ACCESS_OWNER_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_FINANCIAL_OWNER_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_FINANCIAL_OWNER_PROPERTY_IDS: PROPERTY_SCOPE,
    GUEST_JOURNEY_COMPLIANCE_OWNER_ORGANIZATION_IDS: ORG_SCOPE,
    GUEST_JOURNEY_COMPLIANCE_OWNER_PROPERTY_IDS: PROPERTY_SCOPE,
  };
}

function envForProfile(
  profile:
    (typeof GUEST_JOURNEY_ACTIVATION_PROFILES)[number]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GUEST_JOURNEY_APMS_ACTIVATION_PROFILE: profile,
    ...scopedEnv(),
  };

  if (profile === "off") {
    return {
      GUEST_JOURNEY_APMS_ACTIVATION_PROFILE: "off",
    };
  }

  env.GUEST_JOURNEY_SHADOW_ENABLED = "true";

  if (profile === "shadow_only") {
    return env;
  }

  env.GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED = "true";
  env.GUEST_JOURNEY_COORDINATION_INTENTS_ENABLED = "true";

  if (profile === "observe") {
    return env;
  }

  env.GUEST_JOURNEY_OWNER_RUNTIME_ENABLED = "true";
  env.GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ENABLED = "true";

  if (profile === "mission_control_only") {
    return env;
  }

  env.GUEST_JOURNEY_FINANCIAL_OWNER_EXECUTE = "true";
  env.GUEST_JOURNEY_COMPLIANCE_OWNER_EXECUTE = "true";

  if (profile === "execute_non_provider") {
    return env;
  }

  env.GUEST_JOURNEY_ACCESS_OWNER_EXECUTE = "true";

  if (profile === "execute_access_canary") {
    return env;
  }

  env.GUEST_JOURNEY_COMMUNICATIONS_EXECUTE = "true";
  return env;
}

test("E11 activation control plane is default-off and side-effect free", () => {
  const config =
    resolveGuestJourneyActivationControlPlaneConfig({});

  assert.equal(
    config.version,
    GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_VERSION
  );
  assert.equal(config.profile, "off");
  assert.deepEqual(config.enabledStages, []);
  assert.deepEqual(config.scope, {
    organizationIds: [],
    propertyIds: [],
  });
});

test("E11 certifies the full APMS activation profile matrix", () => {
  const expectedStages = {
    off: [],
    shadow_only: ["shadow"],
    observe: [
      "shadow",
      "internalReconcile",
      "coordination",
    ],
    mission_control_only: [
      "shadow",
      "internalReconcile",
      "coordination",
      "ownerRuntime",
      "missionControl",
    ],
    execute_non_provider: [
      "shadow",
      "internalReconcile",
      "coordination",
      "ownerRuntime",
      "missionControl",
      "financialOwner",
      "complianceOwner",
    ],
    execute_access_canary: [
      "shadow",
      "internalReconcile",
      "coordination",
      "ownerRuntime",
      "missionControl",
      "accessOwner",
      "financialOwner",
      "complianceOwner",
    ],
    full_canary: [
      "shadow",
      "internalReconcile",
      "coordination",
      "ownerRuntime",
      "missionControl",
      "communicationsOwner",
      "accessOwner",
      "financialOwner",
      "complianceOwner",
    ],
  } satisfies Record<
    (typeof GUEST_JOURNEY_ACTIVATION_PROFILES)[number],
    string[]
  >;

  for (const profile of GUEST_JOURNEY_ACTIVATION_PROFILES) {
    const config =
      resolveGuestJourneyActivationControlPlaneConfig(
        envForProfile(profile)
      );

    assert.equal(config.profile, profile);
    assert.deepEqual(
      config.enabledStages,
      expectedStages[profile]
    );

    if (profile === "off") {
      assert.deepEqual(config.scope.organizationIds, []);
      assert.deepEqual(config.scope.propertyIds, []);
    } else {
      assert.deepEqual(config.scope.organizationIds, [
        ORG_SCOPE,
      ]);
      assert.deepEqual(config.scope.propertyIds, [
        PROPERTY_SCOPE,
      ]);
    }
  }
});

test("E11 blocks owner execution without coordination materialization", () => {
  assert.throws(
    () =>
      resolveGuestJourneyActivationControlPlaneConfig({
        GUEST_JOURNEY_APMS_ACTIVATION_PROFILE:
          "execute_non_provider",
        ...scopedEnv(),
        GUEST_JOURNEY_SHADOW_ENABLED: "true",
        GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED: "true",
        GUEST_JOURNEY_OWNER_RUNTIME_ENABLED: "true",
        GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ENABLED: "true",
        GUEST_JOURNEY_FINANCIAL_OWNER_EXECUTE: "true",
        GUEST_JOURNEY_COMPLIANCE_OWNER_EXECUTE: "true",
      }),
    /PROFILE_MISMATCH/
  );
});

test("E11 blocks Mission Control without an owner runtime", () => {
  assert.throws(
    () =>
      resolveGuestJourneyActivationControlPlaneConfig({
        GUEST_JOURNEY_APMS_ACTIVATION_PROFILE: "observe",
        ...scopedEnv(),
        GUEST_JOURNEY_SHADOW_ENABLED: "true",
        GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED: "true",
        GUEST_JOURNEY_COORDINATION_INTENTS_ENABLED: "true",
        GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ENABLED: "true",
      }),
    /PROFILE_MISMATCH/
  );
});

test("E11 blocks provider execution outside provider-safe profiles", () => {
  assert.throws(
    () =>
      resolveGuestJourneyActivationControlPlaneConfig({
        ...envForProfile("execute_non_provider"),
        GUEST_JOURNEY_ACCESS_OWNER_EXECUTE: "true",
      }),
    /PROFILE_MISMATCH/
  );

  assert.throws(
    () =>
      resolveGuestJourneyActivationControlPlaneConfig({
        ...envForProfile("execute_access_canary"),
        GUEST_JOURNEY_COMMUNICATIONS_EXECUTE: "true",
      }),
    /PROFILE_MISMATCH/
  );
});

test("E11 requires all enabled stages to share tenant/property scope", () => {
  assert.throws(
    () =>
      resolveGuestJourneyActivationControlPlaneConfig({
        ...envForProfile("execute_non_provider"),
        GUEST_JOURNEY_COMPLIANCE_OWNER_PROPERTY_IDS:
          "property-2",
      }),
    /SCOPE_MISMATCH/
  );
});

test("E11 rejects unknown activation profiles", () => {
  assert.throws(
    () =>
      resolveGuestJourneyActivationControlPlaneConfig({
        GUEST_JOURNEY_APMS_ACTIVATION_PROFILE:
          "execute_everything_now",
      }),
    /ACTIVATION_PROFILE_INVALID/
  );
});
