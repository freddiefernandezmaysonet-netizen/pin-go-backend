import assert from "node:assert/strict";
import test from "node:test";
import { createTurnFixture } from "../runtime/runtime-turn.test-fixture.js";

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

function createPropertyKnowledgeRecord(propertyId: string, organizationId: string) {
  return {
    id: propertyId,
    organizationId,
    name: "Pin&Go Demo Property",
    publicTitle: "Pin&Go Demo Property",
    publicDescription: null,
    publicDescriptionEs: null,
    maxGuests: 3,
    timezone: "America/Puerto_Rico",
    checkInTime: "16:00",
    checkOutTime: "11:00",
    guestAccessMode: "PASSCODE_ONLY",
    amenities: [],
    taxes: [],
    listingDetails: {
      version: 1,
      accommodationType: "ENTIRE_PLACE",
      bedroomCount: 2,
      fullBathroomCount: 1,
      halfBathroomCount: 0,
      minimumPrimaryBookingGuestAge: 21,
      childrenPolicy: "ALLOWED",
      infantsPolicy: "NOT_ALLOWED",
      adultsOnly: "UNKNOWN",
      petsPolicy: "UNKNOWN",
      smokingPolicy: "UNKNOWN",
      vapingPolicy: "UNKNOWN",
      eventsPolicy: "UNKNOWN",
      unregisteredVisitorsPolicy: "UNKNOWN",
      quietHoursEnabled: "UNKNOWN",
      quietHoursStart: null,
      quietHoursEnd: null,
      parkingAvailability: "UNKNOWN",
      parkingType: null,
      parkingFeeType: null,
      parkingVehicleCapacity: null,
      smokeDetector: "UNKNOWN",
      carbonMonoxideDetector: "UNKNOWN",
      exteriorSecurityCameras: "UNKNOWN",
      exteriorSecurityCamerasDisclosureEn: null,
      exteriorSecurityCamerasDisclosureEs: null,
      animalsOnProperty: "UNKNOWN",
      animalsOnPropertyDisclosureEn: null,
      animalsOnPropertyDisclosureEs: null,
      stepFreeEntrance: "UNKNOWN",
      entranceStepCount: null,
      elevatorAvailable: "UNKNOWN",
      accessibleParking: "UNKNOWN",
      stepFreeBedroomAccess: "UNKNOWN",
      stepFreeBathroomAccess: "UNKNOWN",
      stepFreeShower: "UNKNOWN",
      sleepingAreas: [],
      sharedSpaces: [],
      safetyConsiderations: [],
      additionalConsiderations: [],
    },
    locks: [],
    propertyDevices: [],
    guestAgreements: [],
    cancellationPolicies: [],
    knowledgeEntries: [],
    reservations: [{
      id: "reservation-a",
      status: "ACTIVE",
      checkIn: new Date("2026-09-20T20:00:00.000Z"),
      checkOut: new Date("2026-09-22T15:00:00.000Z"),
    }],
  };
}

function createPrisma(reservation: unknown) {
  const calls: unknown[] = [];
  const propertyCalls: unknown[] = [];
  let conversation: {
    reservationId: string;
    openaiSessionId: string | null;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
    lastMessageAt?: Date | null;
    lastErrorCode?: string | null;
  } | null = null;
  const prisma = {
    propertyReview: {
      async aggregate() {
        return { _avg: { overallRating: null }, _count: { _all: 0 } };
      },
    },
    property: {
      async findFirst(args: unknown) {
        propertyCalls.push(args);
        const query = args as { where: { id: string; organizationId: string } };
        return createPropertyKnowledgeRecord(query.where.id, query.where.organizationId);
      },
    },
    reservation: {
      async findFirst(args: unknown) {
        calls.push(args);
        return reservation;
      },
    },
    pinAIGuestConversation: {
      async findUnique() {
        return conversation
          ? { openaiSessionId: conversation.openaiSessionId }
          : null;
      },
      async create(args: {
        data: {
          reservationId: string;
          leaseToken: string;
          leaseExpiresAt: Date;
        };
      }) {
        if (conversation) throw new Error("UNIQUE_CONSTRAINT");
        conversation = {
          reservationId: args.data.reservationId,
          openaiSessionId: null,
          leaseToken: args.data.leaseToken,
          leaseExpiresAt: args.data.leaseExpiresAt,
        };
        return conversation;
      },
      async updateMany(args: {
        where: {
          reservationId: string;
          leaseToken?: string;
          OR?: unknown[];
        };
        data: Partial<NonNullable<typeof conversation>>;
      }) {
        if (!conversation || conversation.reservationId !== args.where.reservationId) {
          return { count: 0 };
        }
        if (
          args.where.leaseToken !== undefined &&
          conversation.leaseToken !== args.where.leaseToken
        ) {
          return { count: 0 };
        }
        if (
          args.where.OR &&
          conversation.leaseToken !== null &&
          conversation.leaseExpiresAt &&
          conversation.leaseExpiresAt >= now
        ) {
          return { count: 0 };
        }
        conversation = { ...conversation, ...args.data };
        return { count: 1 };
      },
    },
  } as unknown as GuestPinAIGatewayPrisma;
  return { prisma, calls, propertyCalls, getConversation: () => conversation };
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
      openaiSessionId: "session_test",
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
  const { prisma, calls, propertyCalls } = createPrisma({
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
  assert.equal(receivedRequest?.context.currentLocalDateTime, "2026-09-21T12:00:00-04:00");
  assert.deepEqual(
    propertyCalls.map((call) => (call as { where: unknown }).where),
    [{ id: "property-a", organizationId: "org-a", status: "ACTIVE" }],
  );
  assert.deepEqual(
    receivedRequest?.context.propertyKnowledge?.facts.find(
      (fact) => fact.key === "listingPolicies",
    )?.value,
    {
      childrenPolicy: "ALLOWED",
      infantsPolicy: "NOT_ALLOWED",
      adultsOnly: "UNKNOWN",
      petsPolicy: "UNKNOWN",
      smokingPolicy: "UNKNOWN",
      vapingPolicy: "UNKNOWN",
      eventsPolicy: "UNKNOWN",
      unregisteredVisitorsPolicy: "UNKNOWN",
      quietHoursEnabled: "UNKNOWN",
      quietHoursStart: null,
      quietHoursEnd: null,
    },
  );
  assert.equal(receivedRequest?.conversation[0]?.content, "¿Puedo salir a la 1 PM?");
  assert.equal(receivedLocation?.label, "San Juan, PR, PR");
  assert.deepEqual(result, {
    reply: "El checkout requiere revisión del host.",
    mode: "SHADOW",
    conversationPersisted: true,
    escalationCreated: false,
    requiresHumanReview: true,
    actionsExecuted: false,
    databaseWrites: true,
    operationalWrites: false,
    webSearch: { enabled: true, used: false },
  });
  assert.equal("toolCalls" in result, false);
});


test("keeps the property-local calendar date when UTC has already crossed midnight", async () => {
  const utcAfterMidnight = new Date("2026-09-26T02:13:00.000Z");
  const { prisma } = createPrisma({
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
  const runtime: GuestPinAIRuntimeRunner = async (request) => {
    receivedRequest = request;
    return shadowResult(request);
  };
  const gateway = new GuestPinAIGateway(
    prisma,
    runtime,
    true,
    () => utcAfterMidnight,
  );

  await gateway.reply({ guestToken: token, message: "¿Qué día es hoy?" });

  assert.equal(
    receivedRequest?.context.currentLocalDateTime,
    "2026-09-25T22:13:00-04:00",
  );
});

test("reuses one server-side OpenAI session for conversational follow-ups", async () => {
  const { prisma, getConversation } = createPrisma({
    id: "reservation-a",
    propertyId: "property-a",
    preferredLanguage: "es",
    property: {
      organizationId: "org-a",
      city: "San Juan",
      region: "PR",
      country: "PR",
      timezone: "America/Puerto_Rico",
    },
  });
  const resumeSessionIds: Array<string | undefined> = [];
  const messages: string[] = [];
  const runtime: GuestPinAIRuntimeRunner = async (
    request,
    _location,
    resumeSessionId,
  ) => {
    resumeSessionIds.push(resumeSessionId);
    messages.push(request.conversation[0]?.content ?? "");
    return shadowResult(request, { openaiSessionId: "session_conversation" });
  };
  const gateway = new GuestPinAIGateway(prisma, runtime, true, () => now);

  await gateway.reply({ guestToken: token, message: "¿Puedo salir tarde?" });
  await gateway.reply({ guestToken: token, message: "¿Y cuánto costaría?" });

  assert.deepEqual(resumeSessionIds, [undefined, "session_conversation"]);
  assert.deepEqual(messages, ["¿Puedo salir tarde?", "¿Y cuánto costaría?"]);
  assert.equal(getConversation()?.openaiSessionId, "session_conversation");
  assert.equal(getConversation()?.leaseToken, null);
});

test("returns a retryable busy error without discarding an existing conversation", async () => {
  const { prisma, getConversation } = createPrisma({
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
  let runtimeCalls = 0;
  const runtime: GuestPinAIRuntimeRunner = async (request) => {
    runtimeCalls += 1;
    if (runtimeCalls === 1) {
      return shadowResult(request, { openaiSessionId: "session_existing" });
    }
    throw new Error("PIN_AI_RUNTIME_AGENT_SESSION_BUSY");
  };
  const gateway = new GuestPinAIGateway(prisma, runtime, true, () => now);

  await gateway.reply({ guestToken: token, message: "First turn" });
  await assert.rejects(
    gateway.reply({ guestToken: token, message: "Second turn" }),
    (error: unknown) =>
      error instanceof GuestPinAIGatewayError &&
      error.code === "CONVERSATION_BUSY",
  );

  assert.equal(getConversation()?.openaiSessionId, "session_existing");
  assert.equal(getConversation()?.leaseToken, null);
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
  const fixture = createTurnFixture({ answer: () => "Three options nearby." });
  const calls = fixture.calls;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const response = await fixture.fetchImpl(url, {
      method: init?.method === "POST" ? "POST" : "GET",
      headers: {},
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const payload = await response.json();
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


test("passes guest authorization to the runtime only through the private runner argument", async () => {
  const { prisma } = createPrisma({
    id: "reservation-a",
    propertyId: "property-a",
    preferredLanguage: "es",
    property: {
      organizationId: "org-a",
      city: "San Juan",
      region: "PR",
      country: "PR",
      timezone: "America/Puerto_Rico",
    },
  });
  let receivedAuthorization:
    Parameters<GuestPinAIRuntimeRunner>[3] |
    undefined;
  let serializedRequest = "";

  const runtime: GuestPinAIRuntimeRunner = async (
    request,
    _location,
    _resumeSessionId,
    actionAuthorization,
  ) => {
    receivedAuthorization =
      actionAuthorization;
    serializedRequest =
      JSON.stringify(request);
    return shadowResult(request);
  };

  const gateway = new GuestPinAIGateway(
    prisma,
    runtime,
    true,
    () => now,
  );

  await gateway.reply({
    guestToken: token,
    message: "Quiero cambiar las fechas.",
  });

  assert.deepEqual(
    receivedAuthorization,
    { guestToken: token },
  );
  assert.equal(
    serializedRequest.includes(token),
    false,
  );
  assert.equal(
    serializedRequest.includes("guestToken"),
    false,
  );
});

test("returns a confirmed-action proposal credential only through the guest gateway response", async () => {
  const { prisma } = createPrisma({
    id: "reservation-a",
    propertyId: "property-a",
    preferredLanguage: "es",
    property: {
      organizationId: "org-a",
      city: "San Juan",
      region: "PR",
      country: "PR",
      timezone: "America/Puerto_Rico",
    },
  });

  const expiresAt =
    new Date("2026-09-21T17:00:00.000Z");

  const runtime: GuestPinAIRuntimeRunner = async (request) => ({
    ...shadowResult(request, {
      responseText:
        "Preparé una cotización válida hasta la hora indicada. La disponibilidad no está retenida; usa el control de confirmación para continuar.",
      toolCalls: [{
        name: "prepare_reservation_modification",
        arguments: {
          proposedCheckInDate: "2026-10-01",
          proposedCheckOutDate: "2026-10-05",
        },
      }],
    }),
    privateActionProposal: {
      publicResult: {
        actionType: "RESERVATION_MODIFICATION",
        proposalId: "proposal-12345678",
        requiresGuestConfirmation: true,
        actionExecuted: false,
        quote: {
          quotedAt: new Date("2026-09-21T16:00:00.000Z"),
          quoteExpiresAt: expiresAt,
          quoteExpiresAtLocal: "2026-09-21T13:00:00-04:00",
          priceGuaranteedUntil: expiresAt,
          propertyTimezone: "America/Puerto_Rico",
          availabilityCheckedAt: new Date("2026-09-21T16:00:00.000Z"),
          availabilityHeld: false,
          currentTotalAmount: 353.35,
          proposedTotalAmount: 521.85,
          amountDifference: 168.5,
          amountDifferenceCents: 16_850,
          currency: "usd",
          financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
        },
      },
      privateConfirmation: {
        proposalId: "proposal-12345678",
        confirmationToken:
          "confirmation-token-private-123456789012345",
        expiresAt,
      },
    },
  });

  const gateway = new GuestPinAIGateway(
    prisma,
    runtime,
    true,
    () => now,
  );

  const result = await gateway.reply({
    guestToken: token,
    message: "Sí, quiero extender la estadía.",
  });

  assert.equal(
    result.actionsExecuted,
    false,
  );
  assert.equal(
    result.operationalWrites,
    false,
  );
  assert.equal(
    result.actionProposal?.proposalId,
    "proposal-12345678",
  );
  assert.equal(
    result.actionProposal?.confirmationToken,
    "confirmation-token-private-123456789012345",
  );
  assert.equal(
    result.actionProposal?.quote.availabilityHeld,
    false,
  );
  assert.equal(
    result.actionProposal?.quote.quoteExpiresAtLocal,
    "2026-09-21T13:00:00-04:00",
  );
});

test("fails closed when private proposal evidence is not paired with exactly one proposal tool call", async () => {
  const { prisma } = createPrisma({
    id: "reservation-a",
    propertyId: "property-a",
    preferredLanguage: "en",
    property: {
      organizationId: "org-a",
      city: null,
      region: null,
      country: null,
      timezone: "America/Puerto_Rico",
    },
  });

  const runtime: GuestPinAIRuntimeRunner = async (request) => ({
    ...shadowResult(request, {
      toolCalls: [],
    }),
    privateActionProposal: {
      publicResult: {
        actionType: "RESERVATION_MODIFICATION",
        proposalId: "proposal-12345678",
        requiresGuestConfirmation: true,
        actionExecuted: false,
        quote: {
          quotedAt: now,
          quoteExpiresAt: new Date(now.getTime() + 60_000),
          quoteExpiresAtLocal: "2026-09-21T12:01:00-04:00",
          priceGuaranteedUntil: new Date(now.getTime() + 60_000),
          propertyTimezone: "America/Puerto_Rico",
          availabilityCheckedAt: now,
          availabilityHeld: false,
          currentTotalAmount: 100,
          proposedTotalAmount: 120,
          amountDifference: 20,
          amountDifferenceCents: 2_000,
          currency: "usd",
          financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
        },
      },
      privateConfirmation: {
        proposalId: "proposal-12345678",
        confirmationToken:
          "confirmation-token-private-123456789012345",
        expiresAt: new Date(now.getTime() + 60_000),
      },
    },
  });

  const gateway = new GuestPinAIGateway(
    prisma,
    runtime,
    true,
    () => now,
  );

  await assert.rejects(
    gateway.reply({
      guestToken: token,
      message: "Proceed.",
    }),
    /PIN_AI_GUEST_GATEWAY_SHADOW_INVARIANT_FAILED/,
  );
});

test(
  "runtime keeps the proposal tool hidden for a reservation outside the canary allowlist",
  async () => {
    const originalFetch =
      globalThis.fetch;
    const fixture =
      createTurnFixture({
        answer: () =>
          "Your reservation remains read-only.",
      });

    globalThis.fetch =
      (async (
        input:
          string | URL | Request,
        init?: RequestInit,
      ) => {
        const response =
          await fixture.fetchImpl(
            String(input),
            {
              method:
                init?.method ===
                "POST"
                  ? "POST"
                  : "GET",
              headers: {},
              ...(typeof init?.body ===
              "string"
                ? {
                    body:
                      init.body,
                  }
                : {}),
            },
          );
        const payload =
          await response.json();
        return new Response(
          JSON.stringify(
            payload,
          ),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/json",
            },
          },
        );
      }) as typeof fetch;

    const runtimeRequest:
      PinAIRuntimeRequest = {
      context: {
        organizationId:
          "org-a",
        propertyId:
          "property-a",
        reservationId:
          "reservation-a",
        guestId:
          "reservation-guest",
        currentLocalDateTime:
          "2026-09-21T12:00:00-04:00",
        preferredLanguage:
          "en",
      },
      conversation: [
        {
          role: "guest",
          content:
            "Change my dates.",
        },
      ],
    };

    try {
      const result =
        await createGuestPinAIRuntimeRunner({
          PIN_AI_RUNTIME_SHADOW_ENABLED:
            "true",
          PIN_AI_RUNTIME_REAL_READ_ENABLED:
            "true",
          PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED:
            "true",
          PIN_AI_ACTION_BROKER_ENABLED:
            "true",
          PIN_AI_ACTION_CANARY_RESERVATION_IDS:
            "reservation-other-12345678",
          PIN_AI_OPENAI_AGENT_ID:
            "agent_test123",
          OPENAI_API_KEY:
            "test-key",
        })(
          runtimeRequest,
          {
            city: "",
            region: "",
            country: "",
            timezone:
              "America/Puerto_Rico",
            label: "",
          },
          undefined,
          {
            guestToken:
              token,
          },
        );

      assert.equal(
        result.actionsExecuted,
        false,
      );
      const payload =
        JSON.parse(
          fixture.calls[0]
            ?.body ?? "{}",
        ) as {
          agent?: {
            tools?: Array<{
              name?: string;
              type?: string;
            }>;
          };
        };
      const functionTools =
        (
          payload.agent
            ?.tools ?? []
        ).filter(
          (tool) =>
            tool.type ===
            "function",
        );

      assert.equal(
        functionTools.length,
        13,
      );
      assert.equal(
        functionTools.some(
          (tool) =>
            tool.name ===
            "prepare_reservation_modification",
        ),
        false,
      );
    } finally {
      globalThis.fetch =
        originalFetch;
    }
  },
);

test(
  "runtime advertises proposal tool only for the explicitly canaried reservation",
  async () => {
    const originalFetch =
      globalThis.fetch;
    const fixture =
      createTurnFixture({
        answer: () =>
          "I can prepare a quote.",
      });

    globalThis.fetch =
      (async (
        input:
          string | URL | Request,
        init?: RequestInit,
      ) => {
        const response =
          await fixture.fetchImpl(
            String(input),
            {
              method:
                init?.method ===
                "POST"
                  ? "POST"
                  : "GET",
              headers: {},
              ...(typeof init?.body ===
              "string"
                ? {
                    body:
                      init.body,
                  }
                : {}),
            },
          );
        const payload =
          await response.json();
        return new Response(
          JSON.stringify(
            payload,
          ),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/json",
            },
          },
        );
      }) as typeof fetch;

    const runtimeRequest:
      PinAIRuntimeRequest = {
      context: {
        organizationId:
          "org-a",
        propertyId:
          "property-a",
        reservationId:
          "reservation-a",
        guestId:
          "reservation-guest",
        currentLocalDateTime:
          "2026-09-21T12:00:00-04:00",
        preferredLanguage:
          "en",
      },
      conversation: [
        {
          role: "guest",
          content:
            "Change my dates.",
        },
      ],
    };

    try {
      await createGuestPinAIRuntimeRunner({
        PIN_AI_RUNTIME_SHADOW_ENABLED:
          "true",
        PIN_AI_RUNTIME_REAL_READ_ENABLED:
          "true",
        PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED:
          "true",
        PIN_AI_ACTION_BROKER_ENABLED:
          "true",
        PIN_AI_ACTION_CANARY_RESERVATION_IDS:
          "reservation-a",
        PIN_AI_OPENAI_AGENT_ID:
          "agent_test123",
        OPENAI_API_KEY:
          "test-key",
      })(
        runtimeRequest,
        {
          city: "",
          region: "",
          country: "",
          timezone:
            "America/Puerto_Rico",
          label: "",
        },
        undefined,
        {
          guestToken:
            token,
        },
      );

      const payload =
        JSON.parse(
          fixture.calls[0]
            ?.body ?? "{}",
        ) as {
          agent?: {
            tools?: Array<{
              name?: string;
              type?: string;
            }>;
          };
        };
      const functionTools =
        (
          payload.agent
            ?.tools ?? []
        ).filter(
          (tool) =>
            tool.type ===
            "function",
        );

      assert.equal(
        functionTools.length,
        14,
      );
      assert.equal(
        functionTools.some(
          (tool) =>
            tool.name ===
            "prepare_reservation_modification",
        ),
        true,
      );
    } finally {
      globalThis.fetch =
        originalFetch;
    }
  },
);

test("runtime proposal gate requires the independently enabled action broker", async () => {
  const runtime = createGuestPinAIRuntimeRunner({
    PIN_AI_RUNTIME_SHADOW_ENABLED: "true",
    PIN_AI_RUNTIME_REAL_READ_ENABLED: "true",
    PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true",
    PIN_AI_ACTION_BROKER_ENABLED: "false",
  });

  const runtimeRequest: PinAIRuntimeRequest = {
    context: {
      organizationId: "org-a",
      propertyId: "property-a",
      reservationId: "reservation-a",
      guestId: "reservation-guest",
      currentLocalDateTime: "2026-09-21T12:00:00-04:00",
      preferredLanguage: "en",
    },
    conversation: [{
      role: "guest",
      content: "Change my dates.",
    }],
  };

  await assert.rejects(
    runtime(
      runtimeRequest,
      {
        city: "",
        region: "",
        country: "",
        timezone: "America/Puerto_Rico",
        label: "",
      },
      undefined,
      { guestToken: token },
    ),
    /PIN_AI_RUNTIME_ACTION_BROKER_REQUIRED/,
  );
});
