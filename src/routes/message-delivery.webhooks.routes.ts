import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import Twilio from "twilio";

import {
  normalizeResendDeliveryEvent,
  normalizeTwilioDeliveryCallback,
  recordMessageDeliveryOutcome,
  verifyResendWebhookSignature,
} from "../services/guest-journey-communications-delivery-outcome.service";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function deliveryWebhooksEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MESSAGE_DELIVERY_WEBHOOKS_ENABLED === "1";
}

function publicApiBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw =
    clean(env.PUBLIC_API_BASE_URL) ||
    clean(env.API_BASE_URL) ||
    clean(env.PUBLIC_BASE_URL);

  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (
      env.NODE_ENV === "production" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function twilioCallbackUrl(env: NodeJS.ProcessEnv): string | null {
  const base = publicApiBaseUrl(env);
  return base
    ? `${base}/webhooks/delivery/twilio`
    : null;
}

export function buildMessageDeliveryWebhookRouter(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env
) {
  const router = Router();

  router.post(
    "/webhooks/delivery/resend",
    async (req: any, res) => {
      if (!deliveryWebhooksEnabled(env)) {
        return res.status(404).json({
          ok: false,
          error: "MESSAGE_DELIVERY_WEBHOOKS_DISABLED",
        });
      }

      const webhookSecret =
        clean(env.RESEND_WEBHOOK_SECRET);

      if (!webhookSecret) {
        return res.status(503).json({
          ok: false,
          error: "RESEND_WEBHOOK_SECRET_MISSING",
        });
      }

      const rawBody = Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString("utf8")
        : null;

      if (!rawBody) {
        return res.status(400).json({
          ok: false,
          error: "RESEND_WEBHOOK_RAW_BODY_MISSING",
        });
      }

      const svixId =
        clean(req.header("svix-id"));
      const svixTimestamp =
        clean(req.header("svix-timestamp"));
      const svixSignature =
        clean(req.header("svix-signature"));

      if (
        !svixId ||
        !svixTimestamp ||
        !svixSignature
      ) {
        return res.status(400).json({
          ok: false,
          error: "RESEND_WEBHOOK_SIGNATURE_HEADERS_MISSING",
        });
      }

      const signatureValid =
        verifyResendWebhookSignature({
          payload: rawBody,
          secret: webhookSecret,
          id: svixId,
          timestamp: svixTimestamp,
          signature: svixSignature,
        });

      if (!signatureValid) {
        return res.status(403).json({
          ok: false,
          error: "RESEND_WEBHOOK_SIGNATURE_INVALID",
        });
      }

      let event: unknown;

      try {
        event = JSON.parse(rawBody);
      } catch {
        return res.status(400).json({
          ok: false,
          error: "RESEND_WEBHOOK_PAYLOAD_INVALID",
        });
      }

      const outcome =
        normalizeResendDeliveryEvent(event);

      if (!outcome) {
        return res.status(202).json({
          ok: true,
          ignored: true,
        });
      }

      try {
        const result =
          await recordMessageDeliveryOutcome(
            prisma,
            outcome
          );

        return res.status(200).json({
          ok: true,
          matched: result.matched,
          applied: result.applied,
        });
      } catch (error) {
        console.error(
          "[MESSAGE_DELIVERY_RESEND_WEBHOOK_FAILED]",
          {
            providerMessageId:
              outcome.providerMessageId,
            status: outcome.status,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }
        );

        return res.status(500).json({
          ok: false,
          error: "MESSAGE_DELIVERY_OUTCOME_PERSIST_FAILED",
        });
      }
    }
  );

  router.post(
    "/webhooks/delivery/twilio",
    async (req: any, res) => {
      if (!deliveryWebhooksEnabled(env)) {
        return res.status(404).send(
          "MESSAGE_DELIVERY_WEBHOOKS_DISABLED"
        );
      }

      const authToken =
        clean(env.TWILIO_AUTH_TOKEN);
      const callbackUrl =
        twilioCallbackUrl(env);
      const signature =
        clean(req.header("x-twilio-signature"));

      if (!authToken || !callbackUrl) {
        return res.status(503).send(
          "TWILIO_DELIVERY_WEBHOOK_CONFIG_MISSING"
        );
      }

      if (!signature) {
        return res.status(403).send(
          "TWILIO_SIGNATURE_MISSING"
        );
      }

      const valid = Twilio.validateRequest(
        authToken,
        signature,
        callbackUrl,
        req.body ?? {}
      );

      if (!valid) {
        return res.status(403).send(
          "TWILIO_SIGNATURE_INVALID"
        );
      }

      const outcome =
        normalizeTwilioDeliveryCallback(
          req.body ?? {}
        );

      if (!outcome) {
        return res.status(204).send();
      }

      try {
        await recordMessageDeliveryOutcome(
          prisma,
          outcome
        );

        return res.status(204).send();
      } catch (error) {
        console.error(
          "[MESSAGE_DELIVERY_TWILIO_WEBHOOK_FAILED]",
          {
            providerMessageId:
              outcome.providerMessageId,
            status: outcome.status,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          }
        );

        return res.status(500).send(
          "MESSAGE_DELIVERY_OUTCOME_PERSIST_FAILED"
        );
      }
    }
  );

  return router;
}

export const __messageDeliveryWebhookInternals = {
  deliveryWebhooksEnabled,
  publicApiBaseUrl,
  twilioCallbackUrl,
};
