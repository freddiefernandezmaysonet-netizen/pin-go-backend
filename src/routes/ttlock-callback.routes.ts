import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

import { applyTtlockGatewayCallbackState } from "../services/ttlock-gateway-health.service";
import { resolveUniqueMappedTtlockGateway } from "../services/ttlock-gateway-mapping.service";

import {
  isTtlockCallbackContentType,
  normalizeTtlockCallbackForm,
  ttlockCallbackFingerprint,
  ttlockCallbackSafeMetadata,
  ttlockCallbackTokenMatches,
} from "../ttlock/ttlock.callback";

export type TtlockCallbackCanaryEvaluation =
  | {
      status: 200;
      body: "success";
      accepted: true;
      fingerprint: string;
      metadata: ReturnType<typeof ttlockCallbackSafeMetadata>;
    }
  | {
      status: 400 | 401 | 415 | 503;
      body: string;
      accepted: false;
    };

export function evaluateTtlockCallbackCanary(input: {
  expectedToken?: string | null;
  receivedToken: unknown;
  contentType: unknown;
  body: unknown;
}): TtlockCallbackCanaryEvaluation {
  const expectedToken = String(input.expectedToken ?? "").trim();

  if (!expectedToken) {
    return {
      status: 503,
      body: "callback unavailable",
      accepted: false,
    };
  }

  if (
    !ttlockCallbackTokenMatches({
      expectedToken,
      receivedToken: input.receivedToken,
    })
  ) {
    return {
      status: 401,
      body: "unauthorized",
      accepted: false,
    };
  }

  if (!isTtlockCallbackContentType(input.contentType)) {
    return {
      status: 415,
      body: "unsupported media type",
      accepted: false,
    };
  }

  const form = normalizeTtlockCallbackForm(input.body);

  if (Object.keys(form).length === 0) {
    return {
      status: 400,
      body: "invalid callback payload",
      accepted: false,
    };
  }

  return {
    status: 200,
    body: "success",
    accepted: true,
    fingerprint: ttlockCallbackFingerprint(form),
    metadata: ttlockCallbackSafeMetadata(form),
  };
}

export function parseTtlockGatewayStateCallback(
  metadata: {
    gatewayId: string | null;
    isOnline: string | null;
    notifyType: string | null;
    serverDate?: string | null;
  }
): {
  gatewayId: number;
  isOnline: boolean;
  occurredAt: Date;
} | null {
  if (
    metadata.notifyType !== "2" ||
    (metadata.isOnline !== "0" && metadata.isOnline !== "1") ||
    !metadata.gatewayId
  ) {
    return null;
  }

  const gatewayId = Number(metadata.gatewayId);
  if (!Number.isInteger(gatewayId) || gatewayId <= 0) {
    return null;
  }

  const serverDate = Number(metadata.serverDate);
  const occurredAt =
    Number.isFinite(serverDate) && serverDate > 0
      ? new Date(serverDate)
      : new Date();

  return {
    gatewayId,
    isOnline: metadata.isOnline === "1",
    occurredAt,
  };
}

export function buildTtlockCallbackCanaryRouter(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env
) {
  const router = Router();

  router.post("/webhooks/ttlock", (req, res) => {
    const result = evaluateTtlockCallbackCanary({
      expectedToken: env.TTLOCK_CALLBACK_TOKEN,
      receivedToken: req.query.token,
      contentType: req.headers["content-type"],
      body: req.body,
    });

    if (!result.accepted) {
      console.warn("[ttlock.callback.canary] rejected", {
        status: result.status,
        reason: result.body,
      });

      return res
        .status(result.status)
        .type("text/plain")
        .send(result.body);
    }

    console.log("[ttlock.callback.canary] received", {
      fingerprint: result.fingerprint,
      ...result.metadata,
    });

    const gatewayState =
      parseTtlockGatewayStateCallback(result.metadata);

    if (gatewayState) {
      void resolveUniqueMappedTtlockGateway(
        prisma,
        gatewayState.gatewayId
      )
        .then(async (resolution) => {
          if (resolution.status !== "RESOLVED" || !resolution.gateway) {
            console.warn(
              "[ttlock.callback.gateway-state] unresolved",
              {
                gatewayId: gatewayState.gatewayId,
                resolution: resolution.status,
                providerRequests: 0,
              }
            );
            return;
          }

          const applied = await applyTtlockGatewayCallbackState(
            prisma,
            {
              organizationId:
                resolution.gateway.organizationId,
              gatewayId: gatewayState.gatewayId,
              isOnline: gatewayState.isOnline,
              occurredAt: gatewayState.occurredAt,
            }
          );

          console.log(
            "[ttlock.callback.gateway-state] completed",
            {
              gatewayId: gatewayState.gatewayId,
              isOnline: gatewayState.isOnline,
              ...applied,
            }
          );
        })
        .catch((error) => {
          console.error(
            "[ttlock.callback.gateway-state] failed",
            {
              gatewayId: gatewayState.gatewayId,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            }
          );
        });
    }

    return res
      .status(200)
      .type("text/plain")
      .send("success");
  });

  return router;
}
