export type GuestJourneyCommunicationsOwnerConfig = {
  enabled: boolean;
  batchSize: number;
  leaseMs: number;
  maxClaims: number;
  retryBaseMs: number;
  providerTimeoutMs: number;
  organizationIds: string[];
  propertyIds: string[];
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseEnabled(raw: string | undefined): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return false;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(
    "GUEST_JOURNEY_COMMUNICATIONS_EXECUTE_INVALID: expected true/false, 1/0, yes/no, or on/off"
  );
}

function parseInteger(input: {
  name: string;
  raw: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = String(input.raw ?? "").trim();
  const value = raw ? Number(raw) : input.fallback;
  if (!Number.isSafeInteger(value) || value < input.min || value > input.max) {
    throw new Error(
      `${input.name}_INVALID: expected integer ${input.min}-${input.max}`
    );
  }
  return value;
}

function parseIds(raw: string | undefined): string[] {
  return [...new Set(
    String(raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )].sort();
}

export function resolveGuestJourneyCommunicationsOwnerConfig(
  env: NodeJS.ProcessEnv = process.env
): GuestJourneyCommunicationsOwnerConfig {
  const enabled = parseEnabled(
    env.GUEST_JOURNEY_COMMUNICATIONS_EXECUTE
  );
  const organizationIds = parseIds(
    env.GUEST_JOURNEY_COMMUNICATIONS_ORGANIZATION_IDS
  );
  const propertyIds = parseIds(
    env.GUEST_JOURNEY_COMMUNICATIONS_PROPERTY_IDS
  );

  if (enabled && organizationIds.length === 0 && propertyIds.length === 0) {
    throw new Error(
      "GUEST_JOURNEY_COMMUNICATIONS_SCOPE_REQUIRED: enable at least one organization or property"
    );
  }

  return {
    enabled,
    batchSize: parseInteger({
      name: "GUEST_JOURNEY_COMMUNICATIONS_BATCH_SIZE",
      raw: env.GUEST_JOURNEY_COMMUNICATIONS_BATCH_SIZE,
      fallback: 20,
      min: 1,
      max: 100,
    }),
    leaseMs: parseInteger({
      name: "GUEST_JOURNEY_COMMUNICATIONS_LEASE_MS",
      raw: env.GUEST_JOURNEY_COMMUNICATIONS_LEASE_MS,
      fallback: 60_000,
      min: 5_000,
      max: 15 * 60_000,
    }),
    maxClaims: parseInteger({
      name: "GUEST_JOURNEY_COMMUNICATIONS_MAX_CLAIMS",
      raw: env.GUEST_JOURNEY_COMMUNICATIONS_MAX_CLAIMS,
      fallback: 3,
      min: 1,
      max: 10,
    }),
    retryBaseMs: parseInteger({
      name: "GUEST_JOURNEY_COMMUNICATIONS_RETRY_BASE_MS",
      raw: env.GUEST_JOURNEY_COMMUNICATIONS_RETRY_BASE_MS,
      fallback: 30_000,
      min: 1_000,
      max: 60 * 60_000,
    }),
    providerTimeoutMs: parseInteger({
      name: "GUEST_JOURNEY_COMMUNICATIONS_PROVIDER_TIMEOUT_MS",
      raw: env.GUEST_JOURNEY_COMMUNICATIONS_PROVIDER_TIMEOUT_MS,
      fallback: 15_000,
      min: 1_000,
      max: 60_000,
    }),
    organizationIds,
    propertyIds,
  };
}

export function isGuestJourneyCommunicationsOwnerScope(
  config: GuestJourneyCommunicationsOwnerConfig,
  input: {
    organizationId?: string | null;
    propertyId?: string | null;
    communicationType?: string | null;
  }
): boolean {
  if (!config.enabled || !String(input.communicationType ?? "").trim()) {
    return false;
  }
  const organizationId = String(input.organizationId ?? "").trim();
  const propertyId = String(input.propertyId ?? "").trim();
  return (
    (organizationId.length > 0 && config.organizationIds.includes(organizationId)) ||
    (propertyId.length > 0 && config.propertyIds.includes(propertyId))
  );
}
