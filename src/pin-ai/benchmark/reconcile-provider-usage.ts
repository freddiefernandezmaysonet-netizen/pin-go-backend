import { OpenAIUsageReconciler } from "./openai-benchmark-usage-reconciler.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_USAGE_RECONCILE_ENABLED !== "true") {
    throw new Error("PIN_AI_BENCHMARK_USAGE_RECONCILE_DISABLED");
  }

  const adminKey = process.env.OPENAI_ADMIN_KEY;
  if (!adminKey) {
    throw new Error("PIN_AI_BENCHMARK_OPENAI_ADMIN_KEY_MISSING");
  }

  const startTimeUnix = parseUnixTime(
    process.env.PIN_AI_BENCHMARK_USAGE_START_UNIX,
    "PIN_AI_BENCHMARK_USAGE_START_UNIX",
  );
  const endTimeUnix = parseUnixTime(
    process.env.PIN_AI_BENCHMARK_USAGE_END_UNIX,
    "PIN_AI_BENCHMARK_USAGE_END_UNIX",
  );

  if (endTimeUnix <= startTimeUnix) {
    throw new Error("PIN_AI_BENCHMARK_USAGE_WINDOW_INVALID");
  }

  const apiKeyId = process.env.OPENAI_BENCHMARK_API_KEY_ID;
  const projectId = process.env.OPENAI_PROJECT_ID;
  if (!apiKeyId && !projectId) {
    throw new Error("PIN_AI_BENCHMARK_USAGE_SCOPE_MISSING");
  }

  const model = process.env.PIN_AI_BENCHMARK_MODEL || undefined;

  const reconciler = new OpenAIUsageReconciler(
    { enabled: true, adminKey },
    async (input, init) => {
      const response = await fetch(input, init);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json(),
      };
    },
  );

  const result = await reconciler.reconcile({
    startTimeUnix,
    endTimeUnix,
    ...(model ? { model } : {}),
    ...(projectId ? { projectId } : {}),
    ...(apiKeyId ? { apiKeyId } : {}),
  });

  console.log(
    JSON.stringify({
      benchmark: true,
      usageReconciliation: true,
      ...result,
    }),
  );
}

function parseUnixTime(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`PIN_AI_BENCHMARK_USAGE_TIME_INVALID:${name}`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_BENCHMARK_USAGE_RECONCILE_FAILED:${message}`);
  process.exitCode = 1;
});
