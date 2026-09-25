import assert from "node:assert/strict";
import test from "node:test";

import type { GuestPinAIGatewayResponse } from "./guest-runtime-gateway.js";
import {
  assertGuestGatewayCanaryEnvironment,
  buildGuestGatewayCanaryReservationWhere,
  runGuestGatewayCanary,
} from "./guest-runtime-gateway-canary.js";

function response(overrides: Partial<GuestPinAIGatewayResponse> = {}): GuestPinAIGatewayResponse {
  return {
    reply: "Respuesta segura.",
    mode: "SHADOW",
    conversationPersisted: true,
    escalationCreated: false,
    requiresHumanReview: false,
    actionsExecuted: false,
    databaseWrites: true,
    operationalWrites: false,
    webSearch: { enabled: false, used: false },
    ...overrides,
  };
}

test("guest gateway canary requires explicit isolated shadow configuration", () => {
  const valid = {
    PIN_AI_GUEST_GATEWAY_CANARY_ENABLED: "true",
    PIN_AI_GUEST_GATEWAY_ENABLED: "true",
    PIN_AI_RUNTIME_SHADOW_ENABLED: "true",
    PIN_AI_RUNTIME_REAL_READ_ENABLED: "true",
    PIN_AI_RUNTIME_WEB_SEARCH_ENABLED: "false",
    PIN_AI_OPENAI_AGENT_ID: "agent_test123",
    OPENAI_API_KEY: "test-key",
  };

  assert.doesNotThrow(() => assertGuestGatewayCanaryEnvironment(valid));

  for (const [key, value, expected] of [
    ["PIN_AI_GUEST_GATEWAY_CANARY_ENABLED", "false", /CANARY_DISABLED/],
    ["PIN_AI_GUEST_GATEWAY_ENABLED", "false", /GUEST_GATEWAY_DISABLED/],
    ["PIN_AI_RUNTIME_SHADOW_ENABLED", "false", /SHADOW_DISABLED/],
    ["PIN_AI_RUNTIME_REAL_READ_ENABLED", "false", /REAL_READ_DISABLED/],
    ["PIN_AI_RUNTIME_WEB_SEARCH_ENABLED", "true", /WEB_SEARCH_MUST_BE_DISABLED/],
  ] as const) {
    assert.throws(
      () => assertGuestGatewayCanaryEnvironment({ ...valid, [key]: value }),
      expected,
    );
  }
});

test("guest gateway canary selector accepts fresh or safely reusable persisted sessions", () => {
  const now = new Date("2026-09-24T23:45:00.000Z");
  const where = buildGuestGatewayCanaryReservationWhere(now);

  assert.deepEqual(where, {
    status: "ACTIVE",
    guestToken: { not: null },
    guestTokenExpiresAt: { gt: now },
    property: { status: "ACTIVE" },
    OR: [
      { pinAIGuestConversation: null },
      {
        pinAIGuestConversation: {
          is: {
            OR: [
              { leaseToken: null },
              { leaseExpiresAt: { lt: now } },
            ],
          },
        },
      },
    ],
  });
});

test("guest gateway canary preserves one session across three shadow turns and observes human review", async () => {
  let calls = 0;
  const messages: string[] = [];
  const gateway = {
    async reply(input: Readonly<{ guestToken: unknown; message: unknown }>) {
      calls += 1;
      messages.push(String(input.message));
      return response({
        reply: `Respuesta segura ${calls}.`,
        requiresHumanReview: calls === 3,
      });
    },
  };

  const result = await runGuestGatewayCanary({
    gateway,
    guestToken: "guest_token_123456789",
    readConversationState: async () => ({
      openaiSessionId: "sess_same",
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    }),
  });

  assert.equal(calls, 3);
  assert.equal(messages.length, 3);
  assert.match(messages[0] ?? "", /estado actual/i);
  assert.match(messages[1] ?? "", /checkout/i);
  assert.match(messages[2] ?? "", /revisión humana/i);
  assert.deepEqual(result, {
    sameSession: true,
    conversationPersisted: true,
    databaseWrites: true,
    operationalWrites: false,
    actionsExecuted: false,
    escalationCreated: false,
    humanReviewObserved: true,
    webSearchUsed: false,
    turnResponseLengths: [19, 19, 19],
  });
});

test("guest gateway canary fails closed if the persisted session changes", async () => {
  let turn = 0;
  await assert.rejects(
    runGuestGatewayCanary({
      gateway: {
        async reply() {
          turn += 1;
          return response({ requiresHumanReview: turn === 3 });
        },
      },
      guestToken: "guest_token_123456789",
      readConversationState: async () => ({
        openaiSessionId: turn < 2 ? "sess_one" : "sess_two",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      }),
    }),
    /PIN_AI_GUEST_GATEWAY_CANARY_SESSION_CHANGED/,
  );
});

test("guest gateway canary rejects unreleased leases and operational invariants", async () => {
  await assert.rejects(
    runGuestGatewayCanary({
      gateway: { async reply() { return response(); } },
      guestToken: "guest_token_123456789",
      readConversationState: async () => ({
        openaiSessionId: "sess_same",
        leaseToken: "lease-active",
        leaseExpiresAt: new Date("2026-09-24T20:00:00Z"),
        lastErrorCode: null,
      }),
    }),
    /PIN_AI_GUEST_GATEWAY_CANARY_LEASE_NOT_RELEASED/,
  );

  await assert.rejects(
    runGuestGatewayCanary({
      gateway: {
        async reply() {
          return response({
            operationalWrites: true as never,
          });
        },
      },
      guestToken: "guest_token_123456789",
      readConversationState: async () => ({
        openaiSessionId: "sess_same",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      }),
    }),
    /PIN_AI_GUEST_GATEWAY_CANARY_SHADOW_INVARIANT_FAILED/,
  );
});

test("guest gateway canary requires the final exception turn to surface human review", async () => {
  await assert.rejects(
    runGuestGatewayCanary({
      gateway: { async reply() { return response(); } },
      guestToken: "guest_token_123456789",
      readConversationState: async () => ({
        openaiSessionId: "sess_same",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      }),
    }),
    /PIN_AI_GUEST_GATEWAY_CANARY_HUMAN_REVIEW_NOT_OBSERVED/,
  );
});
