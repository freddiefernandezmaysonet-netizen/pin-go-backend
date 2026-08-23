export type GuestJourneyOwnerRuntimeConfig = {
  enabled: boolean;
  batchSize: number;
  leaseMs: number;
  maxClaims: number;
  retryBaseMs: number;
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

  if (!value) return false;
  if (ENABLED_VALUES.has(value)) return true;
  if (DISABLED_VALUES.has(value)) return false;

  throw new Error(
    "GUEST_JOURNEY_OWNER_RUNTIME_ENABLED_INVALID: expected true/false, 1/0, yes/no, or on/off"
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
    !Number.isSafeInteger(value) ||
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

export function resolveGuestJourneyOwnerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): GuestJourneyOwnerRuntimeConfig {
  const enabled = parseActivation(
    env.GUEST_JOURNEY_OWNER_RUNTIME_ENABLED
  );
  const organizationIds = parseIdentifierList(
    env.GUEST_JOURNEY_OWNER_RUNTIME_ORGANIZATION_IDS
  );
  const propertyIds = parseIdentifierList(
    env.GUEST_JOURNEY_OWNER_RUNTIME_PROPERTY_IDS
  );

  if (
    enabled &&
    organizationIds.length === 0 &&
    propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_OWNER_RUNTIME_SCOPE_REQUIRED: enable at least one organization or property"
    );
  }

  return {
    enabled,
    batchSize: parseInteger({
      name:
        "GUEST_JOURNEY_OWNER_RUNTIME_BATCH_SIZE",
      rawValue:
        env.GUEST_JOURNEY_OWNER_RUNTIME_BATCH_SIZE,
      fallback: 10,
      min: 1,
      max: 25,
    }),
    leaseMs: parseInteger({
      name:
        "GUEST_JOURNEY_OWNER_RUNTIME_LEASE_MS",
      rawValue:
        env.GUEST_JOURNEY_OWNER_RUNTIME_LEASE_MS,
      fallback: 120_000,
      min: 30_000,
      max: 600_000,
    }),
    maxClaims: parseInteger({
      name:
        "GUEST_JOURNEY_OWNER_RUNTIME_MAX_CLAIMS",
      rawValue:
        env.GUEST_JOURNEY_OWNER_RUNTIME_MAX_CLAIMS,
      fallback: 5,
      min: 1,
      max: 10,
    }),
    retryBaseMs: parseInteger({
      name:
        "GUEST_JOURNEY_OWNER_RUNTIME_RETRY_BASE_MS",
      rawValue:
        env.GUEST_JOURNEY_OWNER_RUNTIME_RETRY_BASE_MS,
      fallback: 60_000,
      min: 1_000,
      max: 900_000,
    }),
    organizationIds,
    propertyIds,
  };
}
