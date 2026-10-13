import "dotenv/config";

// Dedicated opt-in Railway worker, NOT imported by API / existing workers.
// Production is intentionally prohibited pending live SIP/sideband certification.
// It cannot be started through the default npm "worker" command.
export function isSalesVoiceWatchdogStagingWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.RAILWAY_ENVIRONMENT_NAME === "staging"
    && env.SALES_VOICE_WATCHDOG_ENABLED === "true"
    && env.SALES_VOICE_WATCHDOG_RELEASE_CERTIFIED === "true"
    && env.NODE_ENV !== "production";
}

export function salesVoiceWorkerSettings(env: NodeJS.ProcessEnv = process.env) {
  const values = {
    maxCallSeconds: Number(env.SALES_VOICE_MAX_CALL_SECONDS ?? "300"),
    batchSize: Number(env.SALES_VOICE_WATCHDOG_BATCH_SIZE ?? "10"),
    pollMs: Number(env.SALES_VOICE_WATCHDOG_POLL_MS ?? "30000"),
  };
  if (
    !Number.isSafeInteger(values.maxCallSeconds) || values.maxCallSeconds < 60
    || values.maxCallSeconds > 3600
    || !Number.isSafeInteger(values.batchSize) || values.batchSize < 1
    || values.batchSize > 25
    || !Number.isSafeInteger(values.pollMs) || values.pollMs < 10000
    || values.pollMs > 300000
  ) throw new Error("SALES_VOICE_INVALID_WORKER_SETTINGS");
  return values;
}

export async function runIsolatedSalesVoiceWatchdogWorker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isSalesVoiceWatchdogStagingWorkerEnabled(env)) {
    console.log("[SALES_VOICE_WATCHDOG] disabled; no provider or database loaded");
    return;
  }
  const settings = salesVoiceWorkerSettings(env);
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.startsWith("sk-")) {
    throw new Error("SALES_VOICE_WATCHDOG_MISSING_API_KEY");
  }
  if (!env.DATABASE_URL) throw new Error("SALES_VOICE_WATCHDOG_MISSING_DATABASE_URL");

  const { prisma } = await import("../lib/prisma.js");
  const { SalesVoiceLiveWatchdog } = await import("../services/sales-voice-live-watchdog.service.js");
  const watchdog = new SalesVoiceLiveWatchdog(prisma);
  let stopped = false;
  let wake: (() => void) | undefined;
  const halt = () => { stopped = true; wake?.(); };
  process.once("SIGTERM", halt);
  process.once("SIGINT", halt);
  const transport = async (url: string, request: {
    method: "POST"; headers: Record<string, string>; signal: AbortSignal;
  }) => {
    // Fixed-origin URL is constructed and validated by postOneLiveHangup.
    const result = await fetch(url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      redirect: "error",
    });
    return { status: result.status };
  };
  try {
    while (!stopped) {
      // Re-evaluate the external deployment gate on EVERY cycle; disabling the
      // worker must stop new provider operations without awaiting a restart.
      if (!isSalesVoiceWatchdogStagingWorkerEnabled(process.env)) break;
      try {
        const outcome = await watchdog.runOnce({
          policy: {
            enabled: true,
            maxCallSeconds: settings.maxCallSeconds,
            batchSize: settings.batchSize,
          },
          apiKey, transport,
        });
        if (outcome.claimed) {
          console.log("[SALES_VOICE_WATCHDOG] batch", outcome);
        }
      } catch {
        // Never log a key, webhook payload or telephone number.
        console.error("[SALES_VOICE_WATCHDOG] failed; persisted state retained");
      }
      if (!stopped) {
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, settings.pollMs);
          wake = () => { clearTimeout(t); resolve(); };
        });
        wake = undefined;
      }
    }
  } finally {
    process.removeListener("SIGTERM", halt);
    process.removeListener("SIGINT", halt);
    await prisma.$disconnect();
  }
}

// Explicit standalone entrypoint only; test imports cannot start a loop.
if (process.argv[1]?.endsWith("sales-voice-live-watchdog.worker.ts")) {
  void runIsolatedSalesVoiceWatchdogWorker().catch(() => {
    console.error("[SALES_VOICE_WATCHDOG] startup denied");
    process.exitCode = 1;
  });
}
