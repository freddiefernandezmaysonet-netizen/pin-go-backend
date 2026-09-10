import "dotenv/config";
import { pathToFileURL } from "node:url";

import { prisma } from "../lib/prisma.js";
import {
  createChannexAirbnbPostAuthProvider,
  createPrismaOwnerStore,
  runAirbnbPostAuthOwnerCycle,
} from "../distribution/airbnb-post-auth-autopilot.owner.js";
import {
  ensureAirbnbPropertyLifecycleWebhook,
} from "../distribution/airbnb-lifecycle-webhook.production.js";
import {
  createAirbnbPostAuthCanonicalReconciler,
  runAirbnbPostActivationCycle,
} from "../distribution/airbnb-post-auth-production.orchestrator.js";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_SETTLE_MS = 120_000;
const DISABLED_KEEPALIVE_MS = 24 * 60 * 60_000;

export type AirbnbPostAuthWorkerConfig = {
  enabled: boolean;
  pollMs: number;
  settleMs: number;
  apiOrigin: string;
  apiKey: string;
  callbackUrl: string;
  webhookSecret: string;
};

function positiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error("AIRBNB_POST_AUTH_WORKER_CONFIG_INVALID");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("AIRBNB_POST_AUTH_WORKER_CONFIG_INVALID");
  }
  return parsed;
}

export function resolveAirbnbPostAuthWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): AirbnbPostAuthWorkerConfig {
  const enabled = String(env.OTA_AIRBNB_POST_AUTH_AUTOPILOT_ENABLED ?? "").trim() === "true";
  const apiOrigin = String(env.OTA_CONNECTION_PROVIDER_API_ORIGIN ?? "").trim();
  const apiKey = String(env.OTA_CONNECTION_API_KEY ?? "").trim();
  const apiBaseUrl = String(env.API_BASE_URL ?? "").trim().replace(/\/$/, "");
  const webhookSecret = String(env.OTA_CHANNEL_WEBHOOK_SECRET ?? "").trim();
  const callbackUrl = `${apiBaseUrl}/webhooks/ota/channex/channel-lifecycle`;

  if (enabled) {
    if (
      env.NODE_ENV !== "production" ||
      apiOrigin !== "https://app.channex.io" ||
      !apiKey ||
      !apiBaseUrl.startsWith("https://") ||
      webhookSecret.length < 32
    ) {
      throw new Error("AIRBNB_POST_AUTH_WORKER_CONFIG_INVALID");
    }
  }

  return {
    enabled,
    pollMs: positiveInt(
      env.OTA_AIRBNB_POST_AUTH_AUTOPILOT_POLL_MS,
      DEFAULT_POLL_MS,
      10_000,
      300_000
    ),
    settleMs: positiveInt(
      env.OTA_AIRBNB_POST_AUTH_AUTOPILOT_SETTLE_SECONDS,
      DEFAULT_SETTLE_MS / 1000,
      30,
      1800
    ) * 1000,
    apiOrigin,
    apiKey,
    callbackUrl,
    webhookSecret,
  };
}

async function earliestOwnerCandidate() {
  return prisma.otaChannelConnection.findFirst({
    where: {
      provider: "AIRBNB",
      externalConnectionId: { not: null },
      status: {
        in: [
          "NOT_CONNECTED",
          "AUTHORIZATION_REQUIRED",
          "MAPPING_REQUIRED",
          "READINESS_CHECK",
          "ACTIVATION_PENDING",
          "DEGRADED",
          "FAILED",
        ],
      },
    },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      organizationId: true,
      propertyId: true,
      distributionProperty: {
        select: {
          platform: true,
          provisioningStatus: true,
          externalPropertyId: true,
        },
      },
    },
  });
}

export async function runAirbnbPostAuthWorkerTick(args: {
  config: AirbnbPostAuthWorkerConfig;
  now?: Date;
}) {
  if (!args.config.enabled) {
    return { status: "DISABLED" as const };
  }

  const candidate = await earliestOwnerCandidate();
  if (candidate) {
    const externalPropertyId = String(
      candidate.distributionProperty?.externalPropertyId ?? ""
    ).trim();
    if (
      candidate.distributionProperty?.platform !== "CHANNEX" ||
      candidate.distributionProperty?.provisioningStatus !== "READY" ||
      !externalPropertyId
    ) {
      return {
        status: "ACTION_REQUIRED" as const,
        connectionId: candidate.id,
        reason: "DISTRIBUTION_PROPERTY_NOT_READY",
      };
    }

    const webhook = await ensureAirbnbPropertyLifecycleWebhook({
      apiOrigin: args.config.apiOrigin,
      apiKey: args.config.apiKey,
      externalPropertyId,
      callbackUrl: args.config.callbackUrl,
      webhookSecret: args.config.webhookSecret,
    });

    if (webhook.providerMutations === 1) {
      await prisma.apmsAuditEntry.create({
        data: {
          organizationId: candidate.organizationId,
          propertyId: candidate.propertyId,
          entityType: "DISTRIBUTION",
          entityId: candidate.id,
          engine: "OTA_DISTRIBUTION_AUTOPILOT",
          eventType: "LIFECYCLE_WEBHOOK_ENSURED",
          status: "SUCCESS",
          severity: "INFO",
          decisionId: `airbnb-lifecycle-webhook:${candidate.id}:${webhook.webhookId}:${webhook.status.toLowerCase()}`,
          summary: "Airbnb property lifecycle webhook ensured before provider onboarding mutation",
          reason: webhook.status,
          metadata: {
            provider: "AIRBNB",
            webhookId: webhook.webhookId,
            callbackUrl: args.config.callbackUrl,
            externalPropertyId,
            eventMaskScope: "CHANNEL_LIFECYCLE_ONLY",
          },
          startedAt: args.now ?? new Date(),
          completedAt: args.now ?? new Date(),
          durationMs: 0,
        },
      });
      return {
        status: "WEBHOOK_ENSURED" as const,
        connectionId: candidate.id,
        webhookStatus: webhook.status,
        providerMutations: 1 as const,
      };
    }
  }

  const provider = createChannexAirbnbPostAuthProvider({
    apiOrigin: args.config.apiOrigin,
    apiKey: args.config.apiKey,
  });
  const reconcile = createAirbnbPostAuthCanonicalReconciler({
    prisma,
    apiOrigin: args.config.apiOrigin,
    apiKey: args.config.apiKey,
  });

  const owner = await runAirbnbPostAuthOwnerCycle({
    store: createPrismaOwnerStore(prisma),
    provider,
    reconcile,
    limit: 1,
    settleMs: args.config.settleMs,
    now: args.now,
  });

  if (owner.providerMutations > 0) {
    return {
      status: "OWNER_PROVIDER_MUTATION" as const,
      owner,
    };
  }

  const postActivation = await runAirbnbPostActivationCycle({
    prisma,
    provider,
    reconcile,
    limit: 1,
    now: args.now,
  });

  return {
    status: "COMPLETE" as const,
    owner,
    postActivation,
  };
}

export function createAirbnbPostAuthWorker(args: {
  config: AirbnbPostAuthWorkerConfig;
  runTick?: typeof runAirbnbPostAuthWorkerTick;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  const runTick = args.runTick ?? runAirbnbPostAuthWorkerTick;
  const setIntervalFn = args.setIntervalFn ?? setInterval;
  const clearIntervalFn = args.clearIntervalFn ?? clearInterval;
  let interval: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  let stopping = false;

  const tick = async () => {
    if (stopping || current) return;
    current = (async () => {
      try {
        const result = await runTick({ config: args.config });
        console.log("[airbnb.post-auth] tick", JSON.stringify(result));
      } catch (error) {
        console.error(
          "[airbnb.post-auth] tick failed",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        current = null;
      }
    })();
    await current;
  };

  const start = async () => {
    if (!args.config.enabled) return;
    await tick();
    if (!stopping) {
      interval = setIntervalFn(() => void tick(), args.config.pollMs);
    }
  };

  const stop = async () => {
    stopping = true;
    if (interval) {
      clearIntervalFn(interval);
      interval = null;
    }
    if (current) await current;
    await prisma.$disconnect();
  };

  return { start, stop, tick };
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return pathToFileURL(entrypoint).href === import.meta.url;
  } catch {
    return false;
  }
}

async function runProcess() {
  const config = resolveAirbnbPostAuthWorkerConfig();
  const worker = createAirbnbPostAuthWorker({ config });
  let idle: NodeJS.Timeout | null = null;
  let closing = false;

  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    if (idle) clearInterval(idle);
    void worker
      .stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[airbnb.post-auth] shutdown failed", signal, error);
        process.exit(1);
      });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await worker.start();
  if (!config.enabled) {
    console.log("[airbnb.post-auth] idle because runtime is disabled");
    idle = setInterval(() => undefined, DISABLED_KEEPALIVE_MS);
  }
}

if (isDirectExecution()) {
  void runProcess().catch(async (error) => {
    console.error(
      "[airbnb.post-auth] boot failed",
      error instanceof Error ? error.message : String(error)
    );
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
}
