import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../lib/prisma.js";
import { resolveRateRefreshConfig } from "../distribution/rate-refresh.policy.js";
import { runRateRefreshCycle } from "../distribution/rate-refresh.service.js";

const config = resolveRateRefreshConfig(process.env);
const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());
console.log("[distribution.rate-refresh] boot", config);
try {
  while (!shutdown.signal.aborted) {
    if (config.enabled) {
      try {
        const result = await runRateRefreshCycle(prisma);
        if (result.enqueued || result.failed) console.log("[distribution.rate-refresh] cycle", result);
      } catch {
        console.error("[distribution.rate-refresh] DISTRIBUTION_RATE_REFRESH_CYCLE_FAILED");
      }
    }
    try {
      await delay(config.enabled ? config.pollMs : 86400000, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (!shutdown.signal.aborted) throw error;
    }
  }
} finally { await prisma.$disconnect(); }
