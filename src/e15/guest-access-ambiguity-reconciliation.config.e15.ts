export const GUEST_ACCESS_AMBIGUITY_E15_ENV =
  "GUEST_JOURNEY_E15_ACCESS_AMBIGUITY_RECONCILIATION_ENABLED";
export const GUEST_ACCESS_CONTROLLED_REARM_E15_ENV =
  "GUEST_JOURNEY_E15_ACCESS_CONTROLLED_REARM_ENABLED";

export type GuestAccessAmbiguityE15Config = {
  enabled: boolean;
  controlledRearmEnabled: boolean;
  intervalMs: number;
  batchSize: number;
  providerTimeoutMs: number;
  providerPageSize: number;
  providerMaxPages: number;
  absenceConfirmationMinMs: number;
};

function parseBoolean(name: string, raw: string | undefined): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name}_INVALID`);
}

function parseInteger(input: {
  name: string;
  raw: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  const clean = String(input.raw ?? "").trim();
  const value = clean ? Number(clean) : input.fallback;
  if (!Number.isSafeInteger(value) || value < input.min || value > input.max) {
    throw new Error(`${input.name}_INVALID`);
  }
  return value;
}

export function resolveGuestAccessAmbiguityE15Config(
  env: NodeJS.ProcessEnv = process.env
): GuestAccessAmbiguityE15Config {
  const enabled = parseBoolean(
    GUEST_ACCESS_AMBIGUITY_E15_ENV,
    env[GUEST_ACCESS_AMBIGUITY_E15_ENV]
  );
  const controlledRearmEnabled = parseBoolean(
    GUEST_ACCESS_CONTROLLED_REARM_E15_ENV,
    env[GUEST_ACCESS_CONTROLLED_REARM_E15_ENV]
  );

  if (controlledRearmEnabled && !enabled) {
    throw new Error(
      "GUEST_JOURNEY_E15_CONTROLLED_REARM_REQUIRES_RECONCILIATION"
    );
  }

  return {
    enabled,
    controlledRearmEnabled,
    intervalMs: parseInteger({
      name: "GUEST_JOURNEY_E15_ACCESS_RECONCILIATION_INTERVAL_MS",
      raw: env.GUEST_JOURNEY_E15_ACCESS_RECONCILIATION_INTERVAL_MS,
      fallback: 5 * 60_000,
      min: 60_000,
      max: 60 * 60_000,
    }),
    batchSize: parseInteger({
      name: "GUEST_JOURNEY_E15_ACCESS_RECONCILIATION_BATCH_SIZE",
      raw: env.GUEST_JOURNEY_E15_ACCESS_RECONCILIATION_BATCH_SIZE,
      fallback: 20,
      min: 1,
      max: 100,
    }),
    providerTimeoutMs: parseInteger({
      name: "GUEST_JOURNEY_E15_PROVIDER_READ_TIMEOUT_MS",
      raw: env.GUEST_JOURNEY_E15_PROVIDER_READ_TIMEOUT_MS,
      fallback: 10_000,
      min: 1_000,
      max: 60_000,
    }),
    providerPageSize: parseInteger({
      name: "GUEST_JOURNEY_E15_PROVIDER_PAGE_SIZE",
      raw: env.GUEST_JOURNEY_E15_PROVIDER_PAGE_SIZE,
      fallback: 100,
      min: 1,
      max: 100,
    }),
    providerMaxPages: parseInteger({
      name: "GUEST_JOURNEY_E15_PROVIDER_MAX_PAGES",
      raw: env.GUEST_JOURNEY_E15_PROVIDER_MAX_PAGES,
      fallback: 5,
      min: 1,
      max: 20,
    }),
    absenceConfirmationMinMs: parseInteger({
      name: "GUEST_JOURNEY_E15_ABSENCE_CONFIRMATION_MIN_MS",
      raw: env.GUEST_JOURNEY_E15_ABSENCE_CONFIRMATION_MIN_MS,
      fallback: 60_000,
      min: 30_000,
      max: 30 * 60_000,
    }),
  };
}
