import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { saveGuestActionReceipt } from "../pin-ai/guest/guest-history.js";
import { readGuestHistory } from "../pin-ai/guest/guest-history-reader.js";
import { actionModificationRequestId, createDefaultStayTimeChatActions, stayTimeChatEnabled } from "../pin-ai/guest/stay-time-chat-actions.js";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";

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
  prisma: GuestPinAIGatewayPrisma & Partial<Pick<PrismaClient, "pinAIActionProposal" | "reservationModification">>;
  env?: NodeJS.ProcessEnv;
  runtime?: GuestPinAIRuntimeRunner;
  now?: () => Date;
  stayTimeActions?: Pick<ReturnType<typeof createDefaultStayTimeChatActions>, "confirm">;
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

  router.get("/manage/:guestToken/pin-ai/history", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(req.params.guestToken)) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUEST" });
    }
    try {
      const now = input.now?.() ?? new Date();
      const reservation = await input.prisma.reservation.findFirst({
        where: { guestToken: req.params.guestToken, guestTokenExpiresAt: { gt: now }, property: { status: "ACTIVE" } },
        select: { id: true, propertyId: true, property: { select: { organizationId: true } } },
      });
      if (!reservation) return res.status(404).json({ ok: false, error: "RESERVATION_NOT_FOUND" });
      if (!input.prisma.pinAIActionProposal || !input.prisma.reservationModification) {
        return res.status(503).json({ ok: false, error: "PIN_AI_HISTORY_UNAVAILABLE" });
      }
      const messages = await readGuestHistory({
        pinAIGuestConversation: input.prisma.pinAIGuestConversation,
        pinAIActionProposal: input.prisma.pinAIActionProposal,
        reservationModification: input.prisma.reservationModification,
      }, { guestToken: req.params.guestToken, reservationId: reservation.id, propertyId: reservation.propertyId,
        organizationId: reservation.property.organizationId }, now);
      return res.json({ ok: true, version: 1, messages });
    } catch {
      return res.status(503).json({ ok: false, error: "PIN_AI_HISTORY_UNAVAILABLE" });
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

        const proposal = input.prisma.pinAIActionProposal ? await input.prisma.pinAIActionProposal.findFirst({
          where: { id: req.params.proposalId, reservationId: reservation.id, actionType: "RESERVATION_MODIFICATION" },
          select: { id: true, termsSnapshot: true },
        }) : null;
        const isStayTime = proposal && actionModificationRequestId(proposal) === `stay-time:${proposal.id}`;
        if (isStayTime && !stayTimeChatEnabled(reservation.id, env)) {
          return res.status(503).json({ ok: false, error: "PIN_AI_ACTIONS_UNAVAILABLE" });
        }
        const broker = isStayTime ? null :
          input.actionBroker ??
          (
            input.actionBrokerFactory
              ? await input
                  .actionBrokerFactory()
              : await createDefaultActionBroker()
          );

        const result =
          await (isStayTime
            ? (input.stayTimeActions ?? createDefaultStayTimeChatActions(input.prisma as PrismaClient, env, input.now)).confirm
            : broker!.confirmAndExecute.bind(broker))({
              guestToken:
                req.params.guestToken,
              proposalId:
                req.params.proposalId,
              confirmationToken:
                req.body
                  .confirmationToken,
            });

        // A receipt-storage outage must not turn a completed action into an HTTP
        // failure that encourages another confirmation. Canonical status is still
        // authoritative and can be read even when this optional URL copy is absent.
        try {
          await saveGuestActionReceipt(input.prisma, {
            reservationId: reservation.id, guestToken: req.params.guestToken,
          }, result);
        } catch {
          console.error("[public-booking pin-ai history]", { code: "RECEIPT_PERSISTENCE_FAILED" });
        }

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

  // Read receipts without initializing the broker or calling payment providers.
  // Completed canary receipts remain readable when action flags are disabled.
  router.get("/manage/:guestToken/pin-ai/action-proposals/:proposalId/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(req.params.guestToken) ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(req.params.proposalId)) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUEST" });
    }
    if (!input.prisma.pinAIActionProposal || !input.prisma.reservationModification) {
      return res.status(503).json({ ok: false, error: "PIN_AI_ACTION_STATUS_UNAVAILABLE" });
    }
    try {
      const now = input.now?.() ?? new Date();
      const reservation = await input.prisma.reservation.findFirst({
        where: { guestToken: req.params.guestToken, guestTokenExpiresAt: { gt: now }, property: { status: "ACTIVE" } },
        select: { id: true, propertyId: true, property: { select: { organizationId: true } } },
      });
      const notFound = () => res.status(404).json({ ok: false, error: "ACTION_PROPOSAL_NOT_FOUND" });
      if (!reservation) return notFound();
      const proposal = await input.prisma.pinAIActionProposal.findFirst({
        where: { id: req.params.proposalId, reservationId: reservation.id, propertyId: reservation.propertyId,
          organizationId: reservation.property.organizationId, actionType: "RESERVATION_MODIFICATION" },
        select: { id: true, status: true, termsSnapshot: true },
      });
      if (!proposal) return notFound();
      const modification = await input.prisma.reservationModification.findFirst({
        where: { reservationId: reservation.id, clientRequestId: actionModificationRequestId(proposal), requestSource: "PIN_AI_GUEST_SERVICES" },
        select: { id: true, status: true, stripePaymentStatus: true, checkoutExpiresAt: true, appliedAt: true },
      });
      return res.json({ ok: true, status: {
        proposalId: proposal.id, proposalStatus: proposal.status,
        modificationId: modification?.id ?? null, modificationStatus: modification?.status ?? null,
        paymentStatus: modification?.stripePaymentStatus ?? null,
        paymentExpiresAt: modification?.checkoutExpiresAt?.toISOString() ?? null,
        appliedAt: modification?.appliedAt?.toISOString() ?? null,
        checkedAt: now.toISOString(),
      } });
    } catch {
      return res.status(503).json({ ok: false, error: "PIN_AI_ACTION_STATUS_UNAVAILABLE" });
    }
  });

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
  confirmationToken: string;
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
      "confirmationToken" &&
    typeof (value as { confirmationToken?: unknown }).confirmationToken === "string" &&
    (value as { confirmationToken: string }).confirmationToken.length > 0 &&
    (value as { confirmationToken: string }).confirmationToken.length <= 512
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
  if (error instanceof StayTimePolicyError) {
    const unavailable = ["STAY_TIME_CHAT_DISABLED", "STAY_TIME_CHAT_EXECUTION_UNAVAILABLE", "STAY_TIME_CHECKOUT_PROVIDER_UNAVAILABLE"].includes(error.code);
    const missing = ["STAY_TIME_RESERVATION_NOT_FOUND", "STAY_TIME_PROPOSAL_NOT_FOUND"].includes(error.code);
    const invalid = ["INVALID_GUEST_TOKEN", "INVALID_STAY_TIME_REQUEST"].includes(error.code);
    return { status: unavailable ? 503 : missing ? 404 : invalid ? 400 : 409,
      publicCode: unavailable ? "PIN_AI_ACTIONS_UNAVAILABLE" : missing ? "ACTION_PROPOSAL_NOT_FOUND" : invalid ? "INVALID_REQUEST" : "ACTION_REVIEW_REQUIRED",
      logCode: error.code };
  }
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

// Exact codes only: never log arbitrary error messages, names, bodies or causes.
const SAFE_GATEWAY_RUNTIME_CODES = new Set([
  "PIN_AI_RUNTIME_SHADOW_DISABLED",
  "PIN_AI_RUNTIME_REAL_READ_DISABLED",
  "PIN_AI_RUNTIME_ACTION_BROKER_REQUIRED",
  "PIN_AI_RUNTIME_ACTION_AUTHORIZATION_MISSING",
  "PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING",
  "PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING",
  "PIN_AI_RUNTIME_OPENAI_AGENT_ID_INVALID",
  "PIN_AI_RUNTIME_OPENAI_DISABLED",
  "PIN_AI_RUNTIME_OPENAI_INVALID_RESPONSE",
  "PIN_AI_RUNTIME_OPENAI_SESSION_ID_INVALID",
  "PIN_AI_RUNTIME_OPENAI_SESSION_ID_MISMATCH",
  "PIN_AI_RUNTIME_AGENT_SESSION_BUSY",
  "PIN_AI_RUNTIME_AGENT_SESSION_FAILED",
  "PIN_AI_RUNTIME_AGENT_TURN_POLL_LIMIT",
  "PIN_AI_RUNTIME_MODEL_NOT_ALLOWED",
  "PIN_AI_GUEST_GATEWAY_NETWORK_CALL_LIMIT",
]);

function safeGatewayRuntimeLogCode(error: unknown): string {
  if (!(error instanceof Error)) return "PIN_AI_GATEWAY_UNKNOWN_ERROR";
  if (SAFE_GATEWAY_RUNTIME_CODES.has(error.message)) return error.message;
  if (/^PIN_AI_RUNTIME_OPENAI_HTTP_[45][0-9]{2}$/.test(error.message)) {
    return error.message;
  }
  const cause = error.cause;
  if (error instanceof TypeError && error.message === "fetch failed" &&
      cause && typeof cause === "object" && "code" in cause &&
      typeof cause.code === "string" &&
      ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET",
        "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(cause.code)) {
    return `PIN_AI_GATEWAY_NETWORK_${cause.code}`;
  }
  return "PIN_AI_GATEWAY_UNCLASSIFIED_ERROR";
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
    logCode: safeGatewayRuntimeLogCode(error),
  };
}
