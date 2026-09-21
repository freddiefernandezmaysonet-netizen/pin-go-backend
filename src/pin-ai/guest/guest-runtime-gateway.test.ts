import assert from "node:assert/strict";
import test from "node:test";

import { createConversationMemory } from "../runtime/conversation-memory.js";
import type { PinAIRuntimeRequest } from "../runtime/contracts.js";
import type { PinAIShadowRunResult } from "../runtime/shadow-orchestrator.js";
import {
  GuestPinAIGateway,
  GuestPinAIGatewayError,
  createGuestPinAIRuntimeRunner,
  type GuestPinAIGatewayPrisma,
  type GuestPinAIRuntimeRunner,
} from "./guest-runtime-gateway.js";

const token = "12345678-1234-1234-1234-123456789abc";
const now = new Date("2026-09-21T16:00:00.000Z");

function createPrisma(reservation: unknown) {
  const calls: unknown[] = [];
  const prisma = {
    reservation: {
      async findFirst(args: unknown) {
        calls.push(args);
        return reservation;
      },
    },
  } as unknown as GuestPinAIGatewayPrisma;
  return { prisma, calls };
}

function shadowResult(
  request: PinAIRuntimeRequest,
  overrides: Partial<PinAIShadowRunResult["response"]> = {},
): PinAIShadowRunResult {
  return {
    mode: "SHADOW",
    request,
    memory: createConversationMemory(request),
    response: {
      responseText: "El checkout requiere revisión del host.",
      toolCalls: [{ name: "check_late_checkout", arguments: {} }],
      webSearch: { enabled: true, used: false, callCount: 0 },
      escalationCreated: false,
      requiresHumanReview: true,
      ...overrides,
    },
    actionsExecuted: false,
  };
}

test("fails closed before database access when the guest gateway is disabled", async () => {
  const { prisma, calls } = createPrisma(null);
  const runtime: GuestPinAIRuntimeRunner = async (request) => shadowResult(request);
  const gateway = new GuestPinAIGateway(prisma, runtime, false, () => now);

  await assert.rejects(
    gateway.reply({ guestToken: token, message: "Hola" }),
    (error: unknown) =>
      error instanceof GuestPinAIGatewayError &&
      error.code === "GATEWAY_DISABLED",
  );
  assert.equal(calls.length, 0);
});

test("rejects malformed credentials and bounded-message violations before database access", async () => {
  const { prisma, calls } = createPrisma(null);
  const runtime: GuestPinAIRuntimeRunner = async (request) => shadowResult(request);
  const gateway = new GuestPinAIGateway(prisma, runtime, true, () => now);

  await assert.rejects(
    gateway.reply({ guestToken: "short", message: "Hola" }),
    /PIN_AI_GUEST_GATEWAY_INVALID_TOKEN/,
  );
  await assert.rejects(
    gateway.reply({ guestToken: token, message: "x".repeat(2_001) }),
    /PIN_AI_GUEST_GATEWAY_INVALID_MESSAGE/,
  );
  assert.equal(calls.length, 0);
});

test("scopes one valid token to one active reservation and sends no guest PII", async () => {
  const { prisma, calls } = createPrisma({
    id: "reservation-a",
    propertyId: "property-a",
    preferredLanguage: "es-PR",
    property: {
      organizationId: "org-a",
      city: "San Juan",
      region: "PR",
      country: "PR",
      timezone: "America/Puerto_Rico",
    },
  });
  let receivedRequest: PinAIRuntimeRequest | undefined;
  let receivedLocation: Parameters<GuestPinAIRuntimeRunner>[1] | undefined;
  const runtime: GuestPinAIRuntimeRunner = async (request, location) => {
    receivedRequest = request;
    receivedLocation = location;
    return shadowResult(request);
  };
  const gateway = new GuestPinAIGateway(prisma, runtime, true, () => now);

  const result = await gateway.reply({
    guestToken: token,
    message: " ¿Puedo salir a la 1 PM? ",
  });

  assert.equal(calls.length, 1);
  const query = calls[0] as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
  };
  assert.deepEqual(query.where, {
    guestToken: token,
    guestTokenExpiresAt: { gt: now },
    status: "ACTIVE",
    property: { status: "ACTIVE" },
  });
  assert.equal("guestName" in query.select, false);
  assert.equal("guestEmail" in query.select, false);
  assert.equal("guestPhone" in query.select, false);
  assert.equal(receivedRequest?.context.organizationId, "org-a");
  assert.equal(receivedRequest?.context.reservationId, "reservation-a");
  assert.equal(receivedRequest?.context.preferredLanguage, "es");
  assert.equal(receivedRequest?.conversation[0]?.content, "¿Puedo salir a la 1 PM?");
  assert.equal(receivedLocation?.label, "San Juan, PR, PR");
  assert.deepEqual(result, {
    reply: "El checkout requiere revisión del host.",
    mode: "SHADOW",
    conversationPersisted: false,
    escalationCreated: false,
    requiresHumanReview: true,
    actionsExecuted: false,
    databaseWrites: false,
    webSearch: { enabled: true, used: false },
  });
  assert.equal("toolCalls" in result, false);
});

test("does not call the runtime for an invalid, expired, inactive, or cross-scope token", async () => {
  const { prisma } = createPrisma(null);
  let runtimeCalls = 0;
  const runtime: GuestPinAIRuntimeRunner = async (request) => {
    runtimeCalls += 1;
    return shadowResult(request);
  };
  const gateway = new GuestPinAIGateway(prisma, runtime, true, () => now);

  await assert.rejects(
    gateway.reply({ guestToken: token, message: "Hola" }),
    /PIN_AI_GUEST_GATEWAY_RESERVATION_NOT_FOUND/,
  );
  assert.equal(runtimeCalls, 0);
});

test("fails closed if the runtime reports an executed escalation", async () => {
  const { prisma } = createPrisma({
    id: "reservation-a",
    propertyId: "property-a",
    preferredLanguage: "en",
    property: {
      organizationId: "org-a",
      city: null,
      region: null,
      country: null,
      timezone: null,
    },
  });
  const runtime: GuestPinAIRuntimeRunner = async (request) =>
    shadowResult(request, { escalationCreated: true });
  const gateway = new GuestPinAIGateway(prisma, runtime, true, () => now);

  await assert.rejects(
    gateway.reply({ guestToken: token, message: "Please contact the host" }),
    /PIN_AI_GUEST_GATEWAY_SHADOW_INVARIANT_FAILED/,
  );
});

test("enables native OpenAI web search with coarse location only", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });

    const payload = url.endsWith("/items?limit=100&order=asc")
      ? {
          data: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Three options nearby." }],
            },
          ],
        }
      : { id: "session-a", status: "idle", required_actions: [] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const request: PinAIRuntimeRequest = {
    context: {
      organizationId: "org-a",
      propertyId: "property-a",
      reservationId: "reservation-a",
      guestId: "reservation-guest",
      currentLocalDateTime: now.toISOString(),
      preferredLanguage: "en",
    },
    conversation: [{ role: "guest", content: "Find nearby restaurants" }],
  };

  try {
    const result = await createGuestPinAIRuntimeRunner({
      PIN_AI_RUNTIME_SHADOW_ENABLED: "true",
      PIN_AI_RUNTIME_REAL_READ_ENABLED: "true",
      PIN_AI_RUNTIME_WEB_SEARCH_ENABLED: "true",
      PIN_AI_OPENAI_AGENT_ID: "agent_test123",
      OPENAI_API_KEY: "test-key",
    })(request, {
      city: "San Juan",
      region: "PR",
      country: "PR",
      timezone: "America/Puerto_Rico",
      label: "San Juan, PR",
    });

    assert.equal(result.mode, "SHADOW");
    assert.equal(result.actionsExecuted, false);
    assert.equal(result.response.responseText, "Three options nearby.");
    const sessionPayload = JSON.parse(calls[0]?.body ?? "{}") as {
      agent_id?: string;
      agent?: { tools?: unknown[] };
    };
    assert.equal(sessionPayload.agent_id, "agent_test123");
    const serializedTools = JSON.stringify(sessionPayload.agent?.tools ?? []);
    assert.match(serializedTools, /"type":"web_search"/);
    assert.match(serializedTools, /"city":"San Juan"/);
    assert.doesNotMatch(serializedTools, /address|latitude|longitude/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
