export type ChannexGlobalFeedConfig = {
  pollMs: number;
  leaseMs: number;
  maxSourcesPerRun: number;
  maxRevisionsPerRun: number;
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

export function resolveChannexGlobalFeedConfig(
  env: NodeJS.ProcessEnv = process.env
): ChannexGlobalFeedConfig {
  return {
    pollMs: parseIntegerEnv({
      name: "CHANNEX_GLOBAL_FEED_POLL_MS",
      rawValue: env.CHANNEX_GLOBAL_FEED_POLL_MS,
      fallback: 60_000,
      min: 5_000,
      max: 300_000,
    }),
    leaseMs: parseIntegerEnv({
      name: "CHANNEX_GLOBAL_FEED_LEASE_MS",
      rawValue: env.CHANNEX_GLOBAL_FEED_LEASE_MS,
      fallback: 10 * 60_000,
      min: 60_000,
      max: 3_600_000,
    }),
    maxSourcesPerRun: parseIntegerEnv({
      name: "CHANNEX_GLOBAL_FEED_MAX_SOURCES_PER_RUN",
      rawValue: env.CHANNEX_GLOBAL_FEED_MAX_SOURCES_PER_RUN,
      fallback: 25,
      min: 1,
      max: 500,
    }),
    maxRevisionsPerRun: parseIntegerEnv({
      name: "CHANNEX_GLOBAL_FEED_MAX_REVISIONS_PER_RUN",
      rawValue: env.CHANNEX_GLOBAL_FEED_MAX_REVISIONS_PER_RUN,
      fallback: 500,
      min: 1,
      max: 5_000,
    }),
  };
}
