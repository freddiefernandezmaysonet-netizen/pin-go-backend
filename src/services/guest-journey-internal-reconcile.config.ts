import {
  assertGuestJourneyTenantPropertyScope,
} from "./guest-journey-tenant-property-scope.policy";

export type GuestJourneyInternalReconcileConfig = {
  enabled: boolean;
  batchSize: number;
  horizonDays: number;
  lookbackDays: number;
  organizationIds: string[];
  propertyIds: string[];
};

const ENABLED_VALUES = new Set([
  "1",
  "true",
  "yes",
  "on",
]);

const DISABLED_VALUES = new Set([
  "0",
  "false",
  "no",
  "off",
]);

function parseActivation(
  rawValue: string | undefined
): boolean {
  const value = String(rawValue ?? "")
    .trim()
    .toLowerCase();

  if (!value) {
    return false;
  }

  if (ENABLED_VALUES.has(value)) {
    return true;
  }

  if (DISABLED_VALUES.has(value)) {
    return false;
  }

  throw new Error(
    "GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED_INVALID: expected true/false, 1/0, yes/no, or on/off"
  );
}

function parseInteger(input: {
  name: string;
  rawValue: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  const rawValue = String(
    input.rawValue ?? ""
  ).trim();
  const value = rawValue
    ? Number(rawValue)
    : input.fallback;

  if (
    !Number.isInteger(value) ||
    value < input.min ||
    value > input.max
  ) {
    throw new Error(
      `${input.name}_INVALID: expected integer ${input.min}-${input.max}`
    );
  }

  return value;
}

function parseIdentifierList(
  rawValue: string | undefined
): string[] {
  return [
    ...new Set(
      String(rawValue ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].sort();
}

export function resolveGuestJourneyInternalReconcileConfig(
  env: NodeJS.ProcessEnv = process.env
): GuestJourneyInternalReconcileConfig {
  const enabled = parseActivation(
    env.GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED
  );
  const organizationIds =
    parseIdentifierList(
      env.GUEST_JOURNEY_INTERNAL_RECONCILE_ORGANIZATION_IDS
    );
  const propertyIds = parseIdentifierList(
    env.GUEST_JOURNEY_INTERNAL_RECONCILE_PROPERTY_IDS
  );

  assertGuestJourneyTenantPropertyScope({
    enabled,
    scope: {
      organizationIds,
      propertyIds,
    },
    errorCode:
      "GUEST_JOURNEY_INTERNAL_RECONCILE_SCOPE_REQUIRED: enable at least one organization tenant",
  });

  return {
    enabled,
    batchSize: parseInteger({
      name:
        "GUEST_JOURNEY_INTERNAL_RECONCILE_BATCH_SIZE",
      rawValue:
        env.GUEST_JOURNEY_INTERNAL_RECONCILE_BATCH_SIZE,
      fallback: 10,
      min: 1,
      max: 50,
    }),
    horizonDays: parseInteger({
      name:
        "GUEST_JOURNEY_INTERNAL_RECONCILE_HORIZON_DAYS",
      rawValue:
        env.GUEST_JOURNEY_INTERNAL_RECONCILE_HORIZON_DAYS,
      fallback: 90,
      min: 1,
      max: 365,
    }),
    lookbackDays: parseInteger({
      name:
        "GUEST_JOURNEY_INTERNAL_RECONCILE_LOOKBACK_DAYS",
      rawValue:
        env.GUEST_JOURNEY_INTERNAL_RECONCILE_LOOKBACK_DAYS,
      fallback: 7,
      min: 1,
      max: 30,
    }),
    organizationIds,
    propertyIds,
  };
}
