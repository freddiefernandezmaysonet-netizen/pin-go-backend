import "dotenv/config";
import { prisma } from "../lib/prisma.js";
import { buildHostInboxRuntime } from "../channex-messaging/host-inbox.runtime.js";
import { autoConfig } from "../channex-messaging/pin-ai-auto.policy.js";

const runtime = buildHostInboxRuntime({ prisma, env: process.env });
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
try {
  if (!runtime || !autoConfig(process.env).enabled) throw new Error("PIN_AI_CHANNEX_WORKER_DISABLED");
  while (!stopping) {
    try {
      if (await runtime.automation.runNext()) continue;
    } catch { console.error("PIN_AI_CHANNEX_CYCLE_FAILED"); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
} finally { await prisma.$disconnect(); }
