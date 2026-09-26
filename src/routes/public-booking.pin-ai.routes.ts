import { Router } from "express";

import type {
  PinAIActionBroker,
} from "../pin-ai/actions/action-broker.service.js";
import {
  PinAIActionBrokerError,
} from "../pin-ai/actions/action-broker.service.js";
import {
  PinAIActionProposalError,
} from "../pin-ai/actions/action-proposal.service.js";
import {
  resolvePinAIActionCanaryScope,
} from "../pin-ai/actions/action-canary-scope.js";

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
  actionBroker?: Pick<
    PinAIActionBroker,
    "confirmAndExecute"
  >;
  actionBrokerFactory?: () => Promise<
    Pick<
      PinAIActionBroker,
      "confirmAndExecute"
    >
  >;
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

  router.post(
    "/manage/:guestToken/pin-ai/action-proposals/:proposalId/confirm",
    async (req, res) => {
      res.setHeader(
        "Cache-Control",
        "no-store",
      );

      try {
        if (
          env.PIN_AI_ACTION_BROKER_ENABLED !==
          "true"
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "PIN_AI_ACTIONS_UNAVAILABLE",
          });
        }

        if (
          !hasOnlyConfirmationTokenField(
            req.body,
          )
        ) {
          return res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
          });
        }

        const currentDateTime =
          input.now?.() ??
          new Date();
        const reservation =
          await input.prisma
            .reservation
            .findFirst({
              where: {
                guestToken:
                  req.params
                    .guestToken,
                guestTokenExpiresAt: {
                  gt:
                    currentDateTime,
                },
                status: "ACTIVE",
                property: {
                  status:
                    "ACTIVE",
                },
              },
              select: {
                id: true,
              },
            });

        if (!reservation) {
          return res.status(404).json({
            ok: false,
            error:
              "ACTION_PROPOSAL_NOT_FOUND",
          });
        }

        const canary =
          resolvePinAIActionCanaryScope({
            reservationId:
              reservation.id,
            env,
          });

        if (!canary.enabled) {
          return res.status(503).json({
            ok: false,
            error:
              "PIN_AI_ACTIONS_UNAVAILABLE",
          });
        }

        const broker =
          input.actionBroker ??
          (
            input.actionBrokerFactory
              ? await input
                  .actionBrokerFactory()
              : await createDefaultActionBroker()
          );

        const result =
          await broker
            .confirmAndExecute({
              guestToken:
                req.params.guestToken,
              proposalId:
                req.params.proposalId,
              confirmationToken:
                req.body
                  .confirmationToken,
            });

        return res.status(200).json({
          ok: true,
          action: result,
        });
      } catch (error) {
        const mapped =
          mapActionBrokerError(
            error,
          );

        if (
          mapped.status >= 500
        ) {
          console.error(
            "[public-booking pin-ai action]",
            {
              code:
                mapped.logCode,
            },
          );
        }

        return res
          .status(mapped.status)
          .json({
            ok: false,
            error:
              mapped.publicCode,
          });
      }
    },
  );

  return router;
}

async function createDefaultActionBroker(): Promise<
  Pick<
    PinAIActionBroker,
    "confirmAndExecute"
  >
> {
  const module =
    await import(
      "../pin-ai/actions/action-broker.composition.js"
    );

  return module
    .createDefaultPinAIActionBroker();
}

function hasOnlyConfirmationTokenField(
  value: unknown,
): value is {
  confirmationToken: unknown;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const keys =
    Object.keys(
      value as Record<
        string,
        unknown
      >,
    );

  return (
    keys.length === 1 &&
    keys[0] ===
      "confirmationToken"
  );
}

function hasOnlyMessageField(value: unknown): value is { message: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && keys[0] === "message";
}

function mapActionBrokerError(
  error: unknown,
): Readonly<{
  status: number;
  publicCode: string;
  logCode: string;
}> {
  if (
    error instanceof
    PinAIActionBrokerError
  ) {
    if (
      error.code ===
      "ACTION_PROPOSAL_SCOPE_MISMATCH"
    ) {
      return {
        status: 404,
        publicCode:
          "ACTION_PROPOSAL_NOT_FOUND",
        logCode: error.code,
      };
    }

    if (
      error.code ===
      "ACTION_PROPOSAL_NOT_CONFIRMABLE" ||
      error.code ===
      "INVALID_ACTION_TYPE"
    ) {
      return {
        status: 409,
        publicCode:
          "ACTION_REVIEW_REQUIRED",
        logCode: error.code,
      };
    }

    return {
      status:
        error.statusCode >= 500
          ? 502
          : error.statusCode,
      publicCode:
        "PIN_AI_ACTION_UNAVAILABLE",
      logCode: error.code,
    };
  }

  if (
    error instanceof
    PinAIActionProposalError
  ) {
    if (
      error.code ===
      "PROPOSAL_TOKEN_MISMATCH"
    ) {
      return {
        status: 403,
        publicCode:
          "INVALID_CONFIRMATION",
        logCode: error.code,
      };
    }

    if (
      error.code ===
        "INVALID_CONFIRMATION_TOKEN" ||
      error.code ===
        "INVALID_GUEST_TOKEN" ||
      error.code ===
        "INVALID_PROPOSAL_ID"
    ) {
      return {
        status: 400,
        publicCode:
          "INVALID_REQUEST",
        logCode: error.code,
      };
    }

    if (
      error.code ===
        "PROPOSAL_NOT_FOUND" ||
      error.code ===
        "PROPOSAL_SCOPE_MISMATCH"
    ) {
      return {
        status: 404,
        publicCode:
          "ACTION_PROPOSAL_NOT_FOUND",
        logCode: error.code,
      };
    }
  }

  const statusCode =
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    Number.isInteger(
      Number(
        (
          error as {
            statusCode?: unknown;
          }
        ).statusCode,
      ),
    )
      ? Number(
          (
            error as {
              statusCode: unknown;
            }
          ).statusCode,
        )
      : 502;

  return {
    status:
      statusCode >= 400 &&
      statusCode < 500
        ? statusCode
        : 502,
    publicCode:
      statusCode >= 400 &&
      statusCode < 500
        ? "ACTION_REVIEW_REQUIRED"
        : "PIN_AI_ACTION_UNAVAILABLE",
    logCode:
      error instanceof Error
        ? error.name
        : "UnknownError",
  };
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
    if (error.code === "CONVERSATION_BUSY") {
      return {
        status: 409,
        publicCode: "PIN_AI_BUSY",
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
