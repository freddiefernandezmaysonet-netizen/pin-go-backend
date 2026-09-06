import crypto from "node:crypto";
import { Router } from "express";

import {
  ChannexChannelEvidenceError,
  type OtaChannelEvidenceResult,
} from "../distribution/channex-channel-lifecycle.evidence.js";

export const OTA_CHANNEL_WEBHOOK_SECRET_HEADER =
  "x-pin-go-ota-channel-webhook-secret";

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
    const result = await args.applyEvidence(args.body);
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
      code === "OTA_CHANNEL_PROPERTY_MAPPING_NOT_FOUND" ||
      code === "OTA_CHANNEL_CONNECTION_NOT_PREPARED"
        ? 404
        : code === "OTA_DISTRIBUTION_TENANT_MISMATCH" ||
            code === "OTA_CHANNEL_EXTERNAL_CONNECTION_CONFLICT" ||
            code === "OTA_CHANNEL_EVIDENCE_STATE_CONFLICT"
          ? 409
          : code.includes("PAYLOAD") || code.includes("REQUIRED")
            ? 400
            : 422;
    return { status, body: { ok: false, error: code } };
  }
}

export function buildChannexChannelLifecycleWebhookRouter(args: {
  enabled: boolean;
  expectedSecret: string | null | undefined;
  applyEvidence: (payload: unknown) => Promise<OtaChannelEvidenceResult>;
}) {
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
