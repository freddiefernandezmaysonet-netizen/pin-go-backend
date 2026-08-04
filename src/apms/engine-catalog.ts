/*
 * Canonical Pin&Go APMS Engine catalog.
 *
 * This module is the only approved source for Engine identity. Persisted,
 * API-facing and audit contracts must use CanonicalEngineId instead of
 * introducing new free-form Engine names.
 */

export const CANONICAL_ENGINE_IDS = [
  "GUEST_JOURNEY",
  "COMMUNICATIONS",
  "ACCESS",
  "REVENUE",
  "DISTRIBUTION",
  "OPERATIONS",
  "COMPLIANCE",
  "FINANCIAL",
  "MISSION_CONTROL",
] as const;

export type CanonicalEngineId =
  (typeof CANONICAL_ENGINE_IDS)[number];

export const CANONICAL_ENGINE_DISPLAY_NAMES: Readonly<
  Record<CanonicalEngineId, string>
> = {
  GUEST_JOURNEY: "Guest Journey Engine",
  COMMUNICATIONS: "Communications Engine",
  ACCESS: "Access Engine",
  REVENUE: "Revenue Engine",
  DISTRIBUTION: "Distribution Engine",
  OPERATIONS: "Operations Engine",
  COMPLIANCE: "Compliance Engine",
  FINANCIAL: "Financial Engine",
  MISSION_CONTROL: "Mission Control",
};

/*
 * Temporary compatibility aliases for identifiers already present in main.
 *
 * These aliases exist only at the canonical boundary. New producers must use
 * CanonicalEngineId directly. Legacy aliases may be removed after all Engine
 * producers have been migrated and certified.
 */
const LEGACY_ENGINE_ALIASES: Readonly<
  Record<string, CanonicalEngineId>
> = {
  GUEST_JOURNEY: "GUEST_JOURNEY",
  GUESTJOURNEY: "GUEST_JOURNEY",

  COMMUNICATIONS: "COMMUNICATIONS",
  COMMUNICATION: "COMMUNICATIONS",
  MESSAGING: "COMMUNICATIONS",

  ACCESS: "ACCESS",
  DEVICE_HEALTH: "ACCESS",
  DEVICEHEALTH: "ACCESS",

  REVENUE: "REVENUE",

  DISTRIBUTION: "DISTRIBUTION",
  DISTRIBUTION_PMS: "DISTRIBUTION",
  DISTRIBUTIONPMS: "DISTRIBUTION",
  PMS: "DISTRIBUTION",

  OPERATIONS: "OPERATIONS",
  OPERATION: "OPERATIONS",
  CLEANING: "OPERATIONS",

  COMPLIANCE: "COMPLIANCE",
  IDENTITY: "COMPLIANCE",

  FINANCIAL: "FINANCIAL",
  FINANCE: "FINANCIAL",
  PAYMENT: "FINANCIAL",
  PAYMENTS: "FINANCIAL",
  PAYOUT: "FINANCIAL",
  PAYOUTS: "FINANCIAL",

  MISSION_CONTROL: "MISSION_CONTROL",
  MISSIONCONTROL: "MISSION_CONTROL",
};

function normalizeEngineIdentifier(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isCanonicalEngineId(
  value: unknown
): value is CanonicalEngineId {
  return CANONICAL_ENGINE_IDS.includes(
    value as CanonicalEngineId
  );
}

/**
 * Resolves a canonical or approved legacy Engine identifier.
 *
 * Returns null for an empty or unknown identifier. This is intended for
 * compatibility reads and migration boundaries where the caller must decide
 * how to handle historical noncanonical data.
 */
export function normalizeCanonicalEngineId(
  value: unknown
): CanonicalEngineId | null {
  if (isCanonicalEngineId(value)) {
    return value;
  }

  const normalized = normalizeEngineIdentifier(value);

  if (!normalized) {
    return null;
  }

  return (
    LEGACY_ENGINE_ALIASES[normalized] ??
    LEGACY_ENGINE_ALIASES[
      normalized.replace(/_/g, "")
    ] ??
    null
  );
}

/**
 * Strict Engine identity boundary for new writes and canonical contracts.
 */
export function requireCanonicalEngineId(
  value: unknown
): CanonicalEngineId {
  const engineId = normalizeCanonicalEngineId(value);

  if (!engineId) {
    const received = String(value ?? "").trim();

    throw new Error(
      received
        ? `Unknown APMS Engine identifier: ${received}`
        : "APMS Engine identifier is required."
    );
  }

  return engineId;
}

export function getCanonicalEngineDisplayName(
  value: unknown
): string {
  const engineId = requireCanonicalEngineId(value);
  return CANONICAL_ENGINE_DISPLAY_NAMES[engineId];
}
