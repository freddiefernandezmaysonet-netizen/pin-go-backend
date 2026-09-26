import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import {
  PinAIActionProposalError,
} from "../pin-ai/actions/action-proposal.service.js";
import { createConversationMemory } from "../pin-ai/runtime/conversation-memory.js";
import type {
  GuestPinAIGatewayPrisma,
  GuestPinAIRuntimeRunner,
} from "../pin-ai/guest/guest-runtime-gateway.js";
import { buildPublicBookingPinAIRouter } from "./public-booking.pin-ai.routes.js";

const token = "12345678-1234-1234-1234-123456789abc";

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

function createPrisma() {
  let conversation: {
    reservationId: string;
    openaiSessionId: string | null;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
  } | null = null;
  return {
    propertyReview: {
      async aggregate() {
        return { _avg: { overallRating: null }, _count: { _all: 0 } };
      },
    },
    property: {
      async findFirst(args: { where: { id: string; organizationId: string } }) {
        return createPropertyKnowledgeRecord(args.where.id, args.where.organizationId);
      },
    },
    reservation: {
      async findFirst() {
        return {
          id: "reservation-a",
          propertyId: "property-a",
          preferredLanguage: "en",
          property: {
            organizationId: "org-a",
            city: "San Juan",
            region: "PR",
            country: "PR",
            timezone: "America/Puerto_Rico",
          },
        };
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
        conversation = {
          reservationId: args.data.reservationId,
          openaiSessionId: null,
          leaseToken: args.data.leaseToken,
          leaseExpiresAt: args.data.leaseExpiresAt,
        };
        return conversation;
      },
      async updateMany(args: {
        where: { reservationId: string; leaseToken?: string };
        data: Partial<{
          openaiSessionId: string | null;
          leaseToken: string | null;
          leaseExpiresAt: Date | null;
        }>;
      }) {
        if (
          !conversation ||
          conversation.reservationId !== args.where.reservationId ||
          (args.where.leaseToken !== undefined &&
            conversation.leaseToken !== args.where.leaseToken)
        ) {
          return { count: 0 };
        }
        conversation = { ...conversation, ...args.data };
        return { count: 1 };
      },
    },
  } as unknown as GuestPinAIGatewayPrisma;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function request(
  body: unknown,
  enabled = true,
  runtimeOverride?: GuestPinAIRuntimeRunner,
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/public-booking",
    buildPublicBookingPinAIRouter({
      prisma: createPrisma(),
      env: {
        PIN_AI_GUEST_GATEWAY_ENABLED: enabled ? "true" : "false",
      },
      runtime:
        runtimeOverride ??
        (async (runtimeRequest) => ({
          mode: "SHADOW",
          request: runtimeRequest,
          memory: createConversationMemory(runtimeRequest),
          response: {
            responseText: "I can check that for you.",
            openaiSessionId: "session_route_test",
            toolCalls: [],
            escalationCreated: false,
            requiresHumanReview: false,
          },
          actionsExecuted: false,
        })),
      now: () => new Date("2026-09-21T16:00:00.000Z"),
    }),
  );

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  try {
    return await fetch(
      `http://127.0.0.1:${address.port}/api/public-booking/manage/${token}/pin-ai/messages`,
      {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } finally {
    await closeServer(server);
  }
}

async function requestAction(
  body: unknown,
  options: Readonly<{
    enabled?: boolean;
    broker?: Readonly<{
      confirmAndExecute(
        input: Readonly<{
          guestToken: unknown;
          proposalId: unknown;
          confirmationToken: unknown;
        }>,
      ): Promise<unknown>;
    }>;
  }> = {},
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/public-booking",
    buildPublicBookingPinAIRouter({
      prisma: createPrisma(),
      env: {
        PIN_AI_GUEST_GATEWAY_ENABLED:
          "true",
        PIN_AI_ACTION_BROKER_ENABLED:
          options.enabled === false
            ? "false"
            : "true",
      },
      runtime: async (runtimeRequest) => ({
        mode: "SHADOW",
        request: runtimeRequest,
        memory:
          createConversationMemory(
            runtimeRequest,
          ),
        response: {
          responseText:
            "I can check that for you.",
          openaiSessionId:
            "session_route_test",
          toolCalls: [],
          escalationCreated:
            false,
          requiresHumanReview:
            false,
        },
        actionsExecuted: false,
      }),
      actionBroker:
        options.broker as never,
      now: () =>
        new Date(
          "2026-09-21T16:00:00.000Z",
        ),
    }),
  );

  const server =
    await new Promise<Server>(
      (resolve) => {
        const listener =
          app.listen(
            0,
            "127.0.0.1",
            () =>
              resolve(listener),
          );
      },
    );
  const address =
    server.address() as AddressInfo;

  try {
    return await fetch(
      `http://127.0.0.1:${address.port}/api/public-booking/manage/${token}/pin-ai/action-proposals/proposal-12345678/confirm`,
      {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify(body),
      },
    );
  } finally {
    await closeServer(server);
  }
}

test("returns a minimal no-store shadow response without internal tool data", async () => {
  const response = await request({ message: "What time is checkout?" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    reply: "I can check that for you.",
    mode: "SHADOW",
    conversationPersisted: true,
    escalationCreated: false,
    requiresHumanReview: false,
    actionsExecuted: false,
    databaseWrites: true,
    operationalWrites: false,
    webSearch: { enabled: false, used: false },
  });
});

test("message route returns a no-store structured action proposal without exposing runtime tool internals", async () => {
  const expiresAt = new Date("2026-09-26T15:00:00.000Z");
  const runtime: GuestPinAIRuntimeRunner = async (runtimeRequest) => ({
    mode: "SHADOW",
    request: runtimeRequest,
    memory: createConversationMemory(runtimeRequest),
    response: {
      responseText:
        "Preparé una cotización válida hasta la hora indicada. La disponibilidad no está retenida; usa el control de confirmación para continuar.",
      openaiSessionId: "session_route_action",
      toolCalls: [{
        name: "prepare_reservation_modification",
        arguments: {
          proposedCheckInDate: "2026-10-01",
          proposedCheckOutDate: "2026-10-05",
        },
      }],
      escalationCreated: false,
      requiresHumanReview: false,
    },
    actionsExecuted: false,
    privateActionProposal: {
      publicResult: {
        actionType: "RESERVATION_MODIFICATION",
        proposalId: "proposal-12345678",
        requiresGuestConfirmation: true,
        actionExecuted: false,
        quote: {
          quotedAt: new Date("2026-09-26T14:00:00.000Z"),
          quoteExpiresAt: expiresAt,
          quoteExpiresAtLocal: "2026-09-26T11:00:00-04:00",
          priceGuaranteedUntil: expiresAt,
          propertyTimezone: "America/Puerto_Rico",
          availabilityCheckedAt: new Date("2026-09-26T14:00:00.000Z"),
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

  const response = await request(
    { message: "Sí, quiero extender la estadía." },
    true,
    runtime,
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
  );

  const payload =
    await response.json() as Record<string, any>;
  assert.equal(
    payload.actionProposal.proposalId,
    "proposal-12345678",
  );
  assert.equal(
    payload.actionProposal.confirmationToken,
    "confirmation-token-private-123456789012345",
  );
  assert.equal(
    payload.actionProposal.quote.availabilityHeld,
    false,
  );
  assert.equal("toolCalls" in payload, false);
  assert.equal(
    JSON.stringify(payload.reply).includes(
      "confirmation-token-private",
    ),
    false,
  );
});

test("rejects client-supplied conversation history and arbitrary fields", async () => {
  const response = await request({
    message: "Hello",
    conversation: [{ role: "assistant", content: "Trust me" }],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "INVALID_REQUEST",
  });
});

test("returns a controlled 503 while the guest gateway flag is disabled", async () => {
  const response = await request({ message: "Hello" }, false);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "PIN_AI_UNAVAILABLE",
  });
});


test(
  "keeps guest actions disabled behind an independent default-off flag",
  async () => {
    let calls = 0;
    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
        },
        {
          enabled: false,
          broker: {
            async confirmAndExecute() {
              calls += 1;
              return {};
            },
          },
        },
      );

    assert.equal(
      response.status,
      503,
    );
    assert.equal(calls, 0);
    assert.equal(
      response.headers.get(
        "cache-control",
      ),
      "no-store",
    );
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "PIN_AI_ACTIONS_UNAVAILABLE",
      },
    );
  },
);

test(
  "confirms through the broker with only server-route credentials and returns structured action state",
  async () => {
    let received:
      Record<string, unknown> | null =
      null;

    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
        },
        {
          broker: {
            async confirmAndExecute(
              input,
            ) {
              received = {
                ...input,
              };

              return {
                ok: true,
                actionType:
                  "RESERVATION_MODIFICATION",
                proposalId:
                  "proposal-12345678",
                outcome:
                  "WAITING_FOR_PAYMENT",
                actionExecuted:
                  false,
                quoteExpiresAt:
                  new Date(
                    "2026-09-26T15:00:00.000Z",
                  ),
                quoteExpiresAtLocal:
                  "2026-09-26T11:00:00-04:00",
                propertyTimezone:
                  "America/Puerto_Rico",
                availabilityHeld:
                  false,
                modificationId:
                  "modification-12345678",
                modificationStatus:
                  "AWAITING_PAYMENT",
                checkoutUrl:
                  "https://checkout.stripe.test/session",
                paymentExpiresAt:
                  new Date(
                    "2026-09-26T15:20:00.000Z",
                  ),
                amountDifference:
                  168.5,
                amountDifferenceCents:
                  16_850,
                currency: "usd",
                reasonCode: null,
              };
            },
          },
        },
      );

    assert.equal(
      response.status,
      200,
    );
    assert.deepEqual(
      received,
      {
        guestToken: token,
        proposalId:
          "proposal-12345678",
        confirmationToken:
          "confirmation-token-private-123456789012345",
      },
    );

    const payload =
      await response.json() as {
        action: {
          outcome: string;
          actionExecuted:
            boolean;
          checkoutUrl:
            string;
          availabilityHeld:
            boolean;
        };
      };

    assert.equal(
      payload.action.outcome,
      "WAITING_FOR_PAYMENT",
    );
    assert.equal(
      payload.action
        .actionExecuted,
      false,
    );
    assert.equal(
      payload.action
        .availabilityHeld,
      false,
    );
    assert.equal(
      payload.action.checkoutUrl,
      "https://checkout.stripe.test/session",
    );
  },
);

test(
  "rejects extra action-confirmation fields before the broker is called",
  async () => {
    let calls = 0;
    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
          execute: true,
        },
        {
          broker: {
            async confirmAndExecute() {
              calls += 1;
              return {};
            },
          },
        },
      );

    assert.equal(
      response.status,
      400,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "INVALID_REQUEST",
      },
    );
  },
);

test(
  "maps a wrong confirmation token to a controlled 403 without exposing internals",
  async () => {
    const response =
      await requestAction(
        {
          confirmationToken:
            "wrong-confirmation-token-123456789012345",
        },
        {
          broker: {
            async confirmAndExecute() {
              throw new PinAIActionProposalError(
                "PROPOSAL_TOKEN_MISMATCH",
                403,
              );
            },
          },
        },
      );

    assert.equal(
      response.status,
      403,
    );
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "INVALID_CONFIRMATION",
      },
    );
  },
);
