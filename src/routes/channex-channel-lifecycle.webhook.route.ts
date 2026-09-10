import crypto from "node:crypto";
import { Router } from "express";

import {
  ChannexChannelEvidenceError,
  type OtaChannelEvidenceResult,
} from "../distribution/channex-channel-lifecycle.evidence.js";
import { OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER } from "../distribution/channex-channel-lifecycle-webhook.contract.js";
import { normalizeChannexLifecycleWebhookPayload } from "../distribution/airbnb-lifecycle-webhook.production.js";

export const OTA_CHANNEL_WEBHOOK_SECRET_HEADER =
  OTA_CHANNEL_LIFECYCLE_WEBHOOK_SECRET_HEADER;

let airbnbWorkerBootstrapScheduled = false;

function scheduleAirbnbPostAuthWorkerBootstrap(): void {
  if (
    airbnbWorkerBootstrapScheduled ||
    process.env.NODE_ENV !== "production" ||
    process.env.OTA_CONNECTION_CENTER_ENABLED !== "true"
  ) {
    return;
  }
  airbnbWorkerBootstrapScheduled = true;
  setImmediate(() => {
    void import("../workers/airbnb-post-auth-autopilot.worker.js")
      .then(({ startAirbnbPostAuthWorkerInProcess }) =>
        startAirbnbPostAuthWorkerInProcess(process.env)
      )
      .catch((error) => {
        console.error(
          "[airbnb.post-auth] bootstrap failed",
          error instanceof Error ? error.message : String(error)
        );
      });
  });
}

function firstHeader(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function verifyOtaChannelWebhookSecret(args: {
  expectedSecret: string | null | undefined;
  headers: Record<string, unknown>;
}): boolean {
  const expected = String(args.expectedSecret ?? "").trim();
  const received = firstHeader(
    args.headers[OTA_CHANNEL_WEBHOOK_SECRET_HEADER] ??
      args.headers[OTA_CHANNEL_WEBHOOK_SECRET_HEADER.toLowerCase()]
  );
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function processChannexChannelLifecycleWebhook(args: {
  enabled: boolean;
  expectedSecret: string | null | undefined;
  headers: Record<string, unknown>;
  body: unknown;
  applyEvidence: (payload: unknown) => Promise<OtaChannelEvidenceResult>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!args.enabled) {
    return {
      status: 503,
      body: { ok: false, error: "OTA_CHANNEL_LIFECYCLE_RUNTIME_DISABLED" },
    };
  }
  if (!verifyOtaChannelWebhookSecret({
    expectedSecret: args.expectedSecret,
    headers: args.headers,
  })) {
    return {
      status: 401,
      body: { ok: false, error: "INVALID_OTA_CHANNEL_WEBHOOK_AUTHENTICATION" },
    };
  }

  try {
    const result = await args.applyEvidence(
      normalizeChannexLifecycleWebhookPayload(args.body)
    );
    if (result.ignored) {
      return {
        status: 202,
        body: { ok: true, ignored: true, reason: result.ignoredReason ?? "IGNORED" },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        deduped: Boolean(result.deduped),
        eventType: result.eventType ?? null,
      },
    };
  } catch (error) {
    const code =
      error instanceof ChannexChannelEvidenceError
        ? error.code
        : "OTA_CHANNEL_LIFECYCLE_INGEST_FAILED";
    const status =
      code === "OTA_DISTRIBUTION_TENANT_MISMATCH" ||
      code === "OTA_CHANNEL_EXTERNAL_CONNECTION_CONFLICT"
        ? 409
        : code.includes("PAYLOAD") ||
            code.includes("REQUIRED") ||
            code.includes("INVALID") ||
            code === "OTA_CHANNEL_OCCURRED_AT_FUTURE_SKEW"
          ? 400
          : 503;
    return { status, body: { ok: false, error: code } };
  }
}

export function buildChannexChannelLifecycleWebhookRouter(args: {
  enabled: boolean;
  expectedSecret: string | null | undefined;
  applyEvidence: (payload: unknown) => Promise<OtaChannelEvidenceResult>;
}) {
  scheduleAirbnbPostAuthWorkerBootstrap();
  const router = Router();
  router.post("/webhooks/ota/channex/channel-lifecycle", async (req, res) => {
    const result = await processChannexChannelLifecycleWebhook({
      enabled: args.enabled,
      expectedSecret: args.expectedSecret,
      headers: req.headers as Record<string, unknown>,
      body: req.body,
      applyEvidence: args.applyEvidence,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  });
  return router;
}
