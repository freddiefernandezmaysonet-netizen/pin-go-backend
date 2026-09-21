import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import type { PinAIRuntimeRequest } from "../runtime/contracts.js";
import { LunaRuntimeAdapter } from "../runtime/luna-runtime-adapter.js";
import { GuardedPinAIModelAdapter } from "../runtime/model-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "../runtime/openai-agents-runtime-transport.js";
import { createPinGoRuntimeReadToolExecutor } from "../runtime/pin-go-runtime-tools.js";
import {
  PinAIShadowOrchestrator,
  type PinAIShadowRunResult,
} from "../runtime/shadow-orchestrator.js";
import {
  resolveWebSearchLocation,
  type WebSearchLocation,
} from "../runtime/web-search-location.js";

const MAX_GUEST_MESSAGE_LENGTH = 2_000;
const GUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;
const CONVERSATION_LEASE_MS = 90_000;

type GuestReservationScope = Readonly<{
  id: string;
  propertyId: string;
  preferredLanguage: string;
  property: Readonly<{
    organizationId: string;
    city: string | null;
    region: string | null;
    country: string | null;
    timezone: string | null;
  }>;
}>;

export type GuestPinAIGatewayPrisma = Pick<
  PrismaClient,
  "reservation" | "pinAIGuestConversation"
>;

export type GuestPinAIRuntimeRunner = (
  request: PinAIRuntimeRequest,
  location: WebSearchLocation,
  resumeSessionId?: string,
) => Promise<PinAIShadowRunResult>;

export type GuestPinAIGatewayResponse = Readonly<{
  reply: string;
  mode: "SHADOW";
  conversationPersisted: true;
  escalationCreated: false;
  requiresHumanReview: boolean;
  actionsExecuted: false;
  databaseWrites: true;
  operationalWrites: false;
  webSearch: Readonly<{
    enabled: boolean;
    used: boolean;
  }>;
}>;

export class GuestPinAIGatewayError extends Error {
  constructor(
    readonly code:
      | "GATEWAY_DISABLED"
      | "INVALID_TOKEN"
      | "INVALID_MESSAGE"
      | "RESERVATION_NOT_FOUND"
      | "CONVERSATION_BUSY"
      | "CONVERSATION_STATE_CONFLICT"
      | "EMPTY_RUNTIME_RESPONSE"
      | "SHADOW_INVARIANT_FAILED",
  ) {
    super(`PIN_AI_GUEST_GATEWAY_${code}`);
    this.name = "GuestPinAIGatewayError";
  }
}

export class GuestPinAIGateway {
  constructor(
    private readonly prisma: GuestPinAIGatewayPrisma,
    private readonly runtime: GuestPinAIRuntimeRunner,
    private readonly enabled: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reply(input: Readonly<{
    guestToken: unknown;
    message: unknown;
  }>): Promise<GuestPinAIGatewayResponse> {
    if (!this.enabled) {
      throw new GuestPinAIGatewayError("GATEWAY_DISABLED");
    }

    const guestToken = normalizeGuestToken(input.guestToken);
    const message = normalizeGuestMessage(input.message);
    const currentDateTime = this.now();

    const reservation = (await this.prisma.reservation.findFirst({
      where: {
        guestToken,
        guestTokenExpiresAt: { gt: currentDateTime },
        status: "ACTIVE",
        property: { status: "ACTIVE" },
      },
      select: {
        id: true,
        propertyId: true,
        preferredLanguage: true,
        property: {
          select: {
            organizationId: true,
            city: true,
            region: true,
            country: true,
            timezone: true,
          },
        },
      },
    })) as GuestReservationScope | null;

    if (!reservation) {
      throw new GuestPinAIGatewayError("RESERVATION_NOT_FOUND");
    }

    const lease = await this.acquireConversationLease(
      reservation.id,
      currentDateTime,
    );

    const request: PinAIRuntimeRequest = {
      context: {
        organizationId: reservation.property.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        guestId: "reservation-guest",
        currentLocalDateTime: currentDateTime.toISOString(),
        preferredLanguage:
          reservation.preferredLanguage.toLowerCase().startsWith("es")
            ? "es"
            : "en",
      },
      conversation: [{ role: "guest", content: message }],
    };

    let result: PinAIShadowRunResult;
    try {
      result = await this.runtime(
        request,
        resolveWebSearchLocation(reservation.property),
        lease.openaiSessionId ?? undefined,
      );
    } catch (error) {
      await this.releaseFailedConversationLease(
        reservation.id,
        lease.leaseToken,
        error,
      );
      if (
        error instanceof Error &&
        error.message === "PIN_AI_RUNTIME_AGENT_SESSION_BUSY"
      ) {
        throw new GuestPinAIGatewayError("CONVERSATION_BUSY");
      }
      throw error;
    }

    if (
      result.mode !== "SHADOW" ||
      result.actionsExecuted !== false ||
      result.response.escalationCreated !== false
    ) {
      await this.releaseFailedConversationLease(
        reservation.id,
        lease.leaseToken,
        new GuestPinAIGatewayError("SHADOW_INVARIANT_FAILED"),
        true,
      );
      throw new GuestPinAIGatewayError("SHADOW_INVARIANT_FAILED");
    }

    const reply = result.response.responseText.trim();
    if (!reply) {
      await this.releaseFailedConversationLease(
        reservation.id,
        lease.leaseToken,
        new GuestPinAIGatewayError("EMPTY_RUNTIME_RESPONSE"),
        true,
      );
      throw new GuestPinAIGatewayError("EMPTY_RUNTIME_RESPONSE");
    }

    const openaiSessionId = result.response.openaiSessionId;
    if (!openaiSessionId) {
      await this.releaseFailedConversationLease(
        reservation.id,
        lease.leaseToken,
        new GuestPinAIGatewayError("CONVERSATION_STATE_CONFLICT"),
        true,
      );
      throw new GuestPinAIGatewayError("CONVERSATION_STATE_CONFLICT");
    }

    const persisted = await this.prisma.pinAIGuestConversation.updateMany({
      where: {
        reservationId: reservation.id,
        leaseToken: lease.leaseToken,
      },
      data: {
        openaiSessionId,
        leaseToken: null,
        leaseExpiresAt: null,
        lastMessageAt: currentDateTime,
        lastErrorCode: null,
      },
    });
    if (persisted.count !== 1) {
      throw new GuestPinAIGatewayError("CONVERSATION_STATE_CONFLICT");
    }

    return {
      reply,
      mode: "SHADOW",
      conversationPersisted: true,
      escalationCreated: false,
      requiresHumanReview: result.response.requiresHumanReview,
      actionsExecuted: false,
      databaseWrites: true,
      operationalWrites: false,
      webSearch: {
        enabled: result.response.webSearch?.enabled === true,
        used: result.response.webSearch?.used === true,
      },
    };
  }

  private async acquireConversationLease(
    reservationId: string,
    currentDateTime: Date,
  ): Promise<Readonly<{ leaseToken: string; openaiSessionId: string | null }>> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      currentDateTime.getTime() + CONVERSATION_LEASE_MS,
    );
    let conversation = await this.prisma.pinAIGuestConversation.findUnique({
      where: { reservationId },
      select: { openaiSessionId: true },
    });

    if (!conversation) {
      try {
        await this.prisma.pinAIGuestConversation.create({
          data: {
            reservationId,
            leaseToken,
            leaseExpiresAt,
          },
        });
        return { leaseToken, openaiSessionId: null };
      } catch {
        conversation = await this.prisma.pinAIGuestConversation.findUnique({
          where: { reservationId },
          select: { openaiSessionId: true },
        });
      }
    }

    const acquired = await this.prisma.pinAIGuestConversation.updateMany({
      where: {
        reservationId,
        OR: [
          { leaseToken: null },
          { leaseExpiresAt: { lt: currentDateTime } },
        ],
      },
      data: { leaseToken, leaseExpiresAt },
    });
    if (acquired.count !== 1) {
      throw new GuestPinAIGatewayError("CONVERSATION_BUSY");
    }

    conversation = await this.prisma.pinAIGuestConversation.findUnique({
      where: { reservationId },
      select: { openaiSessionId: true },
    });
    if (!conversation) {
      throw new GuestPinAIGatewayError("CONVERSATION_STATE_CONFLICT");
    }
    return { leaseToken, openaiSessionId: conversation.openaiSessionId };
  }

  private async releaseFailedConversationLease(
    reservationId: string,
    leaseToken: string,
    error: unknown,
    resetSession = false,
  ): Promise<void> {
    await this.prisma.pinAIGuestConversation.updateMany({
      where: { reservationId, leaseToken },
      data: {
        ...(resetSession ? { openaiSessionId: null } : {}),
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: sanitizeConversationError(error),
      },
    });
  }
}

export function createGuestPinAIRuntimeRunner(
  env: NodeJS.ProcessEnv = process.env,
): GuestPinAIRuntimeRunner {
  return async (request, location, resumeSessionId) => {
    if (env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
      throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
    }
    if (env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
      throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
    }

    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
    }
    const agentId = env.PIN_AI_OPENAI_AGENT_ID;
    if (!agentId) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING");
    }

    let outboundCalls = 0;
    const guardedFetch = async (
      url: string,
      init: Readonly<{
        method: "GET" | "POST";
        headers: Readonly<Record<string, string>>;
        body?: string;
      }>,
    ) => {
      outboundCalls += 1;
      if (outboundCalls > 60) {
        throw new Error("PIN_AI_GUEST_GATEWAY_NETWORK_CALL_LIMIT");
      }

      const response = await fetch(url, init);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json(),
      };
    };

    const webSearchEnabled =
      env.PIN_AI_RUNTIME_WEB_SEARCH_ENABLED === "true" &&
      location.label.length > 0;
    const transport = new OpenAIAgentsRuntimeTransport(
      {
        enabled: true,
        apiKey,
        agentId,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        model: "gpt-5.6-luna",
        webSearch: {
          enabled: webSearchEnabled,
          mode: "live",
          ...(webSearchEnabled
            ? {
                location: {
                  ...(location.country ? { country: location.country } : {}),
                  ...(location.region ? { region: location.region } : {}),
                  ...(location.city ? { city: location.city } : {}),
                  ...(location.timezone ? { timezone: location.timezone } : {}),
                },
              }
            : {}),
        },
        maxPolls: 50,
        pollDelayMs: 500,
      },
      guardedFetch,
    );
    const model = new GuardedPinAIModelAdapter(
      new LunaRuntimeAdapter(transport),
    );

    return new PinAIShadowOrchestrator(
      model,
      createPinGoRuntimeReadToolExecutor(),
    ).run(request);
  };
}

function sanitizeConversationError(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 120);
}

function normalizeGuestToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!GUEST_TOKEN_PATTERN.test(token)) {
    throw new GuestPinAIGatewayError("INVALID_TOKEN");
  }
  return token;
}

function normalizeGuestMessage(value: unknown): string {
  const message = typeof value === "string" ? value.trim() : "";
  if (
    message.length === 0 ||
    message.length > MAX_GUEST_MESSAGE_LENGTH ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(message)
  ) {
    throw new GuestPinAIGatewayError("INVALID_MESSAGE");
  }
  return message;
}
