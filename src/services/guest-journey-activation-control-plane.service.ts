import {
  resolveGuestJourneyAccessOwnerConfig,
  type GuestJourneyAccessOwnerConfig,
} from "./guest-journey-access-owner.config";
import {
  resolveGuestJourneyCommunicationsOwnerConfig,
  type GuestJourneyCommunicationsOwnerConfig,
} from "./guest-journey-communications-owner.config";
import {
  resolveGuestJourneyComplianceOwnerConfig,
  type GuestJourneyComplianceOwnerConfig,
} from "./guest-journey-compliance-owner.config";
import {
  resolveGuestJourneyCoordinationConfig,
  type GuestJourneyCoordinationConfig,
} from "./guest-journey-coordination.config";
import {
  resolveGuestJourneyFinancialOwnerConfig,
  type GuestJourneyFinancialOwnerConfig,
} from "./guest-journey-financial-owner.config";
import {
  resolveGuestJourneyInternalReconcileConfig,
  type GuestJourneyInternalReconcileConfig,
} from "./guest-journey-internal-reconcile.config";
import {
  resolveGuestJourneyMissionControlConfig,
  type GuestJourneyMissionControlConfig,
} from "./guest-journey-mission-control.config";
import {
  resolveGuestJourneyOwnerRuntimeConfig,
  type GuestJourneyOwnerRuntimeConfig,
} from "./guest-journey-owner-runtime.config";
import {
  resolveGuestJourneyShadowConfig,
  type GuestJourneyShadowConfig,
} from "./guest-journey-shadow.config";

export const GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_VERSION =
  "guest_journey_activation_control_plane_v1" as const;

export const GUEST_JOURNEY_ACTIVATION_PROFILES = [
  "off",
  "shadow_only",
  "observe",
  "mission_control_only",
  "execute_non_provider",
  "execute_access_canary",
  "full_canary",
] as const;

export type GuestJourneyActivationProfile =
  (typeof GUEST_JOURNEY_ACTIVATION_PROFILES)[number];

export type GuestJourneyActivationStage =
  | "shadow"
  | "internalReconcile"
  | "coordination"
  | "ownerRuntime"
  | "missionControl"
  | "communicationsOwner"
  | "accessOwner"
  | "financialOwner"
  | "complianceOwner";

export type GuestJourneyActivationScope = {
  organizationIds: string[];
  propertyIds: string[];
};

export type GuestJourneyActivationControlPlaneConfig = {
  version: typeof GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_VERSION;
  profile: GuestJourneyActivationProfile;
  enabledStages: GuestJourneyActivationStage[];
  scope: GuestJourneyActivationScope;
  configs: {
    shadow: GuestJourneyShadowConfig;
    internalReconcile: GuestJourneyInternalReconcileConfig;
    coordination: GuestJourneyCoordinationConfig;
    ownerRuntime: GuestJourneyOwnerRuntimeConfig;
    missionControl: GuestJourneyMissionControlConfig;
    communicationsOwner: GuestJourneyCommunicationsOwnerConfig;
    accessOwner: GuestJourneyAccessOwnerConfig;
    financialOwner: GuestJourneyFinancialOwnerConfig;
    complianceOwner: GuestJourneyComplianceOwnerConfig;
  };
};

type StageConfig = {
  enabled: boolean;
  organizationIds: string[];
  propertyIds: string[];
};

type StageMap = Record<GuestJourneyActivationStage, StageConfig>;

const PROFILE_STAGE_MATRIX: Record<
  GuestJourneyActivationProfile,
  readonly GuestJourneyActivationStage[]
> = {
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
};

function parseProfile(
  rawValue: string | undefined
): GuestJourneyActivationProfile {
  const value = String(rawValue ?? "")
    .trim()
    .toLowerCase();

  if (!value) {
    return "off";
  }

  if (
    GUEST_JOURNEY_ACTIVATION_PROFILES.includes(
      value as GuestJourneyActivationProfile
    )
  ) {
    return value as GuestJourneyActivationProfile;
  }

  throw new Error(
    "GUEST_JOURNEY_APMS_ACTIVATION_PROFILE_INVALID: expected off, shadow_only, observe, mission_control_only, execute_non_provider, execute_access_canary, or full_canary"
  );
}

function sameSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (value, index) => value === right[index]
  );
}

function scopePresent(
  config: StageConfig
): boolean {
  return (
    config.organizationIds.length > 0 ||
    config.propertyIds.length > 0
  );
}

function assertScopeAligned(
  stage: GuestJourneyActivationStage,
  baseline: GuestJourneyActivationScope,
  candidate: StageConfig
): void {
  if (
    !sameSet(
      baseline.organizationIds,
      candidate.organizationIds
    ) ||
    !sameSet(
      baseline.propertyIds,
      candidate.propertyIds
    )
  ) {
    throw new Error(
      `GUEST_JOURNEY_APMS_ACTIVATION_SCOPE_MISMATCH: ${stage} must use the same tenant/property scope as the activation profile`
    );
  }
}

function enabledStagesFrom(
  stages: StageMap
): GuestJourneyActivationStage[] {
  return (
    Object.entries(stages) as [
      GuestJourneyActivationStage,
      StageConfig,
    ][]
  )
    .filter(([, config]) => config.enabled)
    .map(([stage]) => stage);
}

function assertExactProfileStages(input: {
  profile: GuestJourneyActivationProfile;
  enabledStages: GuestJourneyActivationStage[];
}): void {
  const expected = [
    ...PROFILE_STAGE_MATRIX[input.profile],
  ];

  if (
    !sameSet(
      [...input.enabledStages].sort(),
      expected.sort()
    )
  ) {
    throw new Error(
      `GUEST_JOURNEY_APMS_ACTIVATION_PROFILE_MISMATCH: ${input.profile} does not match enabled E2-E10 stages`
    );
  }
}

function assertDependencyGraph(
  stages: StageMap
): void {
  const active = (stage: GuestJourneyActivationStage) =>
    stages[stage].enabled;

  if (active("internalReconcile") && !active("shadow")) {
    throw new Error(
      "GUEST_JOURNEY_APMS_ACTIVATION_DEPENDENCY_MISSING: internal reconcile requires shadow"
    );
  }

  if (
    active("coordination") &&
    (!active("shadow") ||
      !active("internalReconcile"))
  ) {
    throw new Error(
      "GUEST_JOURNEY_APMS_ACTIVATION_DEPENDENCY_MISSING: coordination requires shadow and internal reconcile"
    );
  }

  for (const ownerStage of [
    "ownerRuntime",
    "communicationsOwner",
    "accessOwner",
    "financialOwner",
    "complianceOwner",
  ] as const) {
    if (
      active(ownerStage) &&
      !active("coordination")
    ) {
      throw new Error(
        `GUEST_JOURNEY_APMS_ACTIVATION_DEPENDENCY_MISSING: ${ownerStage} requires coordination intents`
      );
    }
  }

  if (
    active("missionControl") &&
    !(
      active("ownerRuntime") ||
      active("communicationsOwner") ||
      active("accessOwner") ||
      active("financialOwner") ||
      active("complianceOwner")
    )
  ) {
    throw new Error(
      "GUEST_JOURNEY_APMS_ACTIVATION_DEPENDENCY_MISSING: mission control requires at least one owner runtime"
    );
  }

  if (
    active("accessOwner") &&
    !active("ownerRuntime")
  ) {
    throw new Error(
      "GUEST_JOURNEY_APMS_ACTIVATION_DEPENDENCY_MISSING: access owner requires access evaluation owner runtime"
    );
  }
}

export function resolveGuestJourneyActivationControlPlaneConfig(
  env: NodeJS.ProcessEnv = process.env
): GuestJourneyActivationControlPlaneConfig {
  const profile = parseProfile(
    env.GUEST_JOURNEY_APMS_ACTIVATION_PROFILE
  );
  const configs = {
    shadow: resolveGuestJourneyShadowConfig(env),
    internalReconcile:
      resolveGuestJourneyInternalReconcileConfig(env),
    coordination:
      resolveGuestJourneyCoordinationConfig(env),
    ownerRuntime:
      resolveGuestJourneyOwnerRuntimeConfig(env),
    missionControl:
      resolveGuestJourneyMissionControlConfig(env),
    communicationsOwner:
      resolveGuestJourneyCommunicationsOwnerConfig(env),
    accessOwner:
      resolveGuestJourneyAccessOwnerConfig(env),
    financialOwner:
      resolveGuestJourneyFinancialOwnerConfig(env),
    complianceOwner:
      resolveGuestJourneyComplianceOwnerConfig(env),
  };
  const stages: StageMap = configs;
  const enabledStages = enabledStagesFrom(stages);

  assertExactProfileStages({
    profile,
    enabledStages,
  });

  assertDependencyGraph(stages);

  const firstScopedStage = enabledStages.find(
    (stage) => scopePresent(stages[stage])
  );
  const scope = firstScopedStage
    ? {
        organizationIds:
          stages[firstScopedStage].organizationIds,
        propertyIds:
          stages[firstScopedStage].propertyIds,
      }
    : { organizationIds: [], propertyIds: [] };

  if (
    profile !== "off" &&
    !scopePresent({
      enabled: true,
      ...scope,
    })
  ) {
    throw new Error(
      "GUEST_JOURNEY_APMS_ACTIVATION_SCOPE_REQUIRED: enabled profiles require tenant/property scope"
    );
  }

  for (const stage of enabledStages) {
    assertScopeAligned(
      stage,
      scope,
      stages[stage]
    );
  }

  return {
    version:
      GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_VERSION,
    profile,
    enabledStages,
    scope,
    configs,
  };
}
