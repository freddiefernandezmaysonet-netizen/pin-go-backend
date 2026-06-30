import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });

import { prisma } from "../lib/prisma";
import { syncChannexAvailabilityForProperty } from "../services/channex-availability-sync.service";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import type { AuditEntry } from "../apms/audit-types";

const WORKER_NAME = "dynamic-pricing-sync.worker";

const POLL_MS = Number(
  process.env.DYNAMIC_PRICING_SYNC_WORKER_POLL_MS ?? 6 * 60 * 60 * 1000
);

const BATCH_SIZE = Number(
  process.env.DYNAMIC_PRICING_SYNC_BATCH_SIZE ?? 10
);

const WINDOW_DAYS = Number(
  process.env.DYNAMIC_PRICING_SYNC_WINDOW_DAYS ?? 365
);

let running = false;
let shuttingDown = false;

function log(...args: any[]) {
  console.log(`[${WORKER_NAME}]`, ...args);
}

function errLog(...args: any[]) {
  console.error(`[${WORKER_NAME}]`, ...args);
}

function toErrString(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function tick() {
  if (running) {
    log("Previous tick still running. Skipping.");
    return;
  }

  running = true;

  try {
   const properties = await prisma.property.findMany({
  where: {
    distributionEnabled: true,
  },
  select: {
    id: true,
    name: true,
    organizationId: true,
 },
  take: BATCH_SIZE,
  orderBy: {
    updatedAt: "asc",
  },
});
    log(
      `Found ${properties.length} active distributed propert${
        properties.length === 1 ? "y" : "ies"
      } to sync.`
    );

    for (const property of properties) {
    const distributionStartedAt = new Date();
const distributionDateKey = distributionStartedAt
  .toISOString()
  .slice(0, 10);

const distributionDecisionId = `distribution-engine:${property.id}:dynamic-pricing-worker:${distributionDateKey}`;
   
     try {
        log(`Syncing ${property.name ?? property.id}...`);
      const result = await syncChannexAvailabilityForProperty(
  property.id,
  WINDOW_DAYS
);

if (result?.skipped) {
  log(
    `Skipped ${property.name ?? property.id}: ${
      result.reason ?? "UNKNOWN_REASON"
    }`
  );
  continue;
}

const distributionCompletedAt = new Date();

const distributionSyncSucceeded =
  result && typeof result === "object" && "ok" in result
    ? Boolean((result as any).ok)
    : true;

const distributionAuditEntry: AuditEntry = {
  engine: "Distribution",
  decisionId: distributionDecisionId,
  entityType: "DISTRIBUTION",
  entityId: property.id,
  eventType: distributionSyncSucceeded
    ? "SYNC_COMPLETED"
    : "SYNC_FAILED",
  status: distributionSyncSucceeded ? "SUCCESS" : "FAILED",
  severity: distributionSyncSucceeded ? "INFO" : "WARNING",
  summary: distributionSyncSucceeded
    ? "Distribution Engine synchronized channel availability from the dynamic pricing worker."
    : "Distribution Engine could not fully synchronize channel availability from the dynamic pricing worker.",
  startedAt: distributionStartedAt,
  completedAt: distributionCompletedAt,
  durationMs:
    distributionCompletedAt.getTime() - distributionStartedAt.getTime(),
  reason: distributionSyncSucceeded
    ? "DYNAMIC_PRICING_WORKER_DISTRIBUTION_SYNC_COMPLETED"
    : "DYNAMIC_PRICING_WORKER_DISTRIBUTION_SYNC_FAILED",
  decisions: [
    {
      engine: "Distribution",
      rule: "DYNAMIC_PRICING_WORKER_CHANNEX_AVAILABILITY_SYNC",
      label: "Dynamic Pricing Worker Channel Availability Sync",
      applied: distributionSyncSucceeded,
      adjustment: null,
      adjustmentPercent: null,
      confidence: distributionSyncSucceeded ? 100 : 0,
      metadata: {
        organizationId: property.organizationId,
        propertyId: property.id,
        provider: "CHANNEX",
        syncType: "AVAILABILITY",
        trigger: "DYNAMIC_PRICING_WORKER",
        windowDays: WINDOW_DAYS,
        resultOk:
          result && typeof result === "object" && "ok" in result
            ? (result as any).ok
            : null,
        pushedToChannex:
          result &&
          typeof result === "object" &&
          "pushedToChannex" in result
            ? (result as any).pushedToChannex
            : null,
      },
    },
  ],
  recommendedAction: distributionSyncSucceeded
    ? undefined
    : "Review Channex sync result from the dynamic pricing worker.",
  metadata: {
    organizationId: property.organizationId,
    propertyId: property.id,
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    trigger: "DYNAMIC_PRICING_WORKER",
    windowDays: WINDOW_DAYS,
    resultOk:
      result && typeof result === "object" && "ok" in result
        ? (result as any).ok
        : null,
    pushedToChannex:
      result &&
      typeof result === "object" &&
      "pushedToChannex" in result
        ? (result as any).pushedToChannex
        : null,
  },
};

try {
  await persistAuditEntry(prisma, distributionAuditEntry);
} catch (auditPersistenceError: any) {
  console.error("[APMS_DISTRIBUTION_WORKER_AUDIT_PERSIST_ERROR]", {
    engine: "Distribution",
    propertyId: property.id,
    provider: "CHANNEX",
    syncType: "AVAILABILITY",
    trigger: "DYNAMIC_PRICING_WORKER",
    decisionId: distributionAuditEntry.decisionId,
    error: auditPersistenceError?.message ?? auditPersistenceError,
  });
}

log(`Synced ${property.name ?? property.id}.`);
     } catch (error) {
  const distributionCompletedAt = new Date();

  errLog(
    `Failed to sync ${property.name ?? property.id}:`,
    toErrString(error)
  );

  await prisma.property.update({
    where: {
      id: property.id,
    },
    data: {
      distributionLastError: toErrString(error),
    },
  });

  const distributionAuditEntry: AuditEntry = {
    engine: "Distribution",
    decisionId: distributionDecisionId,
    entityType: "DISTRIBUTION",
    entityId: property.id,
    eventType: "SYNC_FAILED",
    status: "FAILED",
    severity: "CRITICAL",
    summary:
      "Distribution Engine failed to synchronize channel availability from the dynamic pricing worker.",
    startedAt: distributionStartedAt,
    completedAt: distributionCompletedAt,
    durationMs:
      distributionCompletedAt.getTime() - distributionStartedAt.getTime(),
    reason: "DYNAMIC_PRICING_WORKER_DISTRIBUTION_SYNC_ERROR",
    decisions: [
      {
        engine: "Distribution",
        rule: "DYNAMIC_PRICING_WORKER_CHANNEX_AVAILABILITY_SYNC",
        label: "Dynamic Pricing Worker Channel Availability Sync",
        applied: false,
        adjustment: null,
        adjustmentPercent: null,
        confidence: 0,
        metadata: {
          organizationId: property.organizationId,
          propertyId: property.id,
          provider: "CHANNEX",
          syncType: "AVAILABILITY",
          trigger: "DYNAMIC_PRICING_WORKER",
          windowDays: WINDOW_DAYS,
          error: toErrString(error),
        },
      },
    ],
    recommendedAction:
      "Review Channex availability connection and retry the dynamic pricing worker sync.",
    metadata: {
      organizationId: property.organizationId,
      propertyId: property.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "DYNAMIC_PRICING_WORKER",
      windowDays: WINDOW_DAYS,
      error: toErrString(error),
    },
  };

  try {
    await persistAuditEntry(prisma, distributionAuditEntry);
  } catch (auditPersistenceError: any) {
    console.error("[APMS_DISTRIBUTION_WORKER_AUDIT_PERSIST_ERROR]", {
      engine: "Distribution",
      propertyId: property.id,
      provider: "CHANNEX",
      syncType: "AVAILABILITY",
      trigger: "DYNAMIC_PRICING_WORKER",
      decisionId: distributionAuditEntry.decisionId,
      error: auditPersistenceError?.message ?? auditPersistenceError,
    });
  }
}  
     
    }
  } catch (error) {
    errLog("Tick failed:", toErrString(error));
  } finally {
    running = false;
  }
}

async function start() {
  log(
    `Starting. poll=${POLL_MS}ms batch=${BATCH_SIZE} window=${WINDOW_DAYS}d`
  );

  log(
    "ENV DATABASE_URL =",
    process.env.DATABASE_URL ? process.env.DATABASE_URL : "❌ UNDEFINED"
  );

  await tick();

  const interval = setInterval(() => void tick(), POLL_MS);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`Received ${signal}. Shutting down...`);
    clearInterval(interval);

    try {
      await prisma.$disconnect();
      log("Disconnected Prisma. Bye.");
    } catch (error) {
      errLog("Error on disconnect:", toErrString(error));
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void start().catch((error) => {
  errLog("Fatal start error:", toErrString(error));
  process.exit(1);
});