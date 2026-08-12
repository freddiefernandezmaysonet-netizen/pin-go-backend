export type PmsWebhookRecoveryConfig = {
  pollMs: number;
  batchSize: number;
  maxAttempts: number;
  pendingMinAgeMs: number;
  retryDelayMs: number;
  staleProcessingMs: number;
};

function parseIntegerEnv(args: {
  name: string;
  rawValue: string | undefined;
  fallback: number;
  min: number;
  max: number;
}) {
  const raw = String(args.rawValue ?? "").trim();
  const value = raw ? Number(raw) : args.fallback;

  if (!Number.isInteger(value) || value < args.min || value > args.max) {
    throw new Error(
      `${args.name}_INVALID: expected integer ${args.min}-${args.max}`
    );
  }

  return value;
}

export function resolvePmsWebhookRecoveryConfig(
  env: NodeJS.ProcessEnv = process.env
): PmsWebhookRecoveryConfig {
  return {
    pollMs: parseIntegerEnv({
      name: "PMS_WEBHOOK_RECOVERY_POLL_MS",
      rawValue: env.PMS_WEBHOOK_RECOVERY_POLL_MS,
      fallback: 60_000,
      min: 1_000,
      max: 300_000,
    }),
    batchSize: parseIntegerEnv({
      name: "PMS_WEBHOOK_RECOVERY_BATCH_SIZE",
      rawValue: env.PMS_WEBHOOK_RECOVERY_BATCH_SIZE,
      fallback: 20,
      min: 1,
      max: 100,
    }),
    maxAttempts: parseIntegerEnv({
      name: "PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS",
      rawValue: env.PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS,
      fallback: 8,
      min: 1,
      max: 20,
    }),
    pendingMinAgeMs: parseIntegerEnv({
      name: "PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS",
      rawValue: env.PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS,
      fallback: 30_000,
      min: 0,
      max: 300_000,
    }),
    retryDelayMs: parseIntegerEnv({
      name: "PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS",
      rawValue: env.PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS,
      fallback: 60_000,
      min: 1_000,
      max: 3_600_000,
    }),
    staleProcessingMs: parseIntegerEnv({
      name: "PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS",
      rawValue: env.PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS,
      fallback: 10 * 60_000,
      min: 60_000,
      max: 86_400_000,
    }),
  };
}
