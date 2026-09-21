import { Router } from "express";

import {
  createGuestPinAIRuntimeRunner,
  GuestPinAIGateway,
  GuestPinAIGatewayError,
  type GuestPinAIGatewayPrisma,
  type GuestPinAIRuntimeRunner,
} from "../pin-ai/guest/guest-runtime-gateway.js";

export function buildPublicBookingPinAIRouter(input: Readonly<{
  prisma: GuestPinAIGatewayPrisma;
  env?: NodeJS.ProcessEnv;
  runtime?: GuestPinAIRuntimeRunner;
  now?: () => Date;
}>) {
  const router = Router();
  const env = input.env ?? process.env;
  const gateway = new GuestPinAIGateway(
    input.prisma,
    input.runtime ?? createGuestPinAIRuntimeRunner(env),
    env.PIN_AI_GUEST_GATEWAY_ENABLED === "true",
    input.now,
  );

  router.post("/manage/:guestToken/pin-ai/messages", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    try {
      if (!hasOnlyMessageField(req.body)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
        });
      }

      const result = await gateway.reply({
        guestToken: req.params.guestToken,
        message: req.body.message,
      });

      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      const mapped = mapGatewayError(error);
      if (mapped.status >= 500 && mapped.logCode !== "GATEWAY_DISABLED") {
        console.error("[public-booking pin-ai gateway]", {
          code: mapped.logCode,
        });
      }
      return res.status(mapped.status).json({
        ok: false,
        error: mapped.publicCode,
      });
    }
  });

  return router;
}

function hasOnlyMessageField(value: unknown): value is { message: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && keys[0] === "message";
}

function mapGatewayError(error: unknown): Readonly<{
  status: number;
  publicCode: string;
  logCode: string;
}> {
  if (error instanceof GuestPinAIGatewayError) {
    if (error.code === "GATEWAY_DISABLED") {
      return {
        status: 503,
        publicCode: "PIN_AI_UNAVAILABLE",
        logCode: error.code,
      };
    }
    if (error.code === "INVALID_TOKEN" || error.code === "INVALID_MESSAGE") {
      return {
        status: 400,
        publicCode: "INVALID_REQUEST",
        logCode: error.code,
      };
    }
    if (error.code === "RESERVATION_NOT_FOUND") {
      return {
        status: 404,
        publicCode: "RESERVATION_NOT_FOUND",
        logCode: error.code,
      };
    }
    return {
      status: 502,
      publicCode: "PIN_AI_UNAVAILABLE",
      logCode: error.code,
    };
  }

  return {
    status: 502,
    publicCode: "PIN_AI_UNAVAILABLE",
    logCode: error instanceof Error ? error.name : "UnknownError",
  };
}
