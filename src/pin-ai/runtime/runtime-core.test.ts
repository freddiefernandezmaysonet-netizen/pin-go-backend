import assert from "node:assert/strict";
import test from "node:test";

import type { PinAIRuntimeRequest } from "./contracts.js";
import {
  assertMemoryMatchesRequest,
  createConversationMemory,
} from "./conversation-memory.js";
import {
  GuardedPinAIRuntimeToolExecutor,
  type PinAIRuntimeToolExecutor,
} from "./tool-executor.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
    currentLocalDateTime: "2026-09-20T10:00:00-04:00",
    preferredLanguage: "es",
  },
  conversation: [
    { role: "assistant", content: "We already completed the approved thermostat reset." },
    { role: "guest", content: "The door opened now." },
  ],
};

test("conversation memory is stay-scoped and retains resolved/troubleshooting facts", () => {
  const memory = createConversationMemory(request);

  assert.equal(memory.organizationId, "org-a");
  assert.equal(memory.propertyId, "property-a");
  assert.equal(memory.reservationId, "reservation-a");
  assert.equal(memory.guestId, "guest-a");
  assert.equal(memory.preferredLanguage, "es");
  assert.equal(memory.facts.accessResolved, true);
  assert.deepEqual(memory.attemptedTroubleshooting, ["THERMOSTAT_RESET"]);
});

test("conversation memory rejects cross-reservation reuse", () => {
  const memory = createConversationMemory(request);

  assert.throws(
    () =>
      assertMemoryMatchesRequest(memory, {
        ...request,
        context: {
          ...request.context,
          reservationId: "reservation-b",
        },
      }),
    /PIN_AI_RUNTIME_MEMORY_SCOPE_MISMATCH/,
  );
});

test("guarded executor preserves tenant and stay scope", async () => {
  const delegate: PinAIRuntimeToolExecutor = {
    async execute(tool) {
      assert.equal(tool, "get_access_status");
      return { accessStatus: "ACTIVE" };
    },
  };

  const executor = new GuardedPinAIRuntimeToolExecutor(delegate);
  const memory = createConversationMemory(request);

  const result = await executor.execute(
    "get_access_status",
    {},
    request,
    memory,
  );

  assert.deepEqual(result, {
    accessStatus: "ACTIVE",
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
  });
});

test("guarded executor rejects disabled tools before delegation", async () => {
  let delegateExecutions = 0;
  const delegate: PinAIRuntimeToolExecutor = {
    async execute() {
      delegateExecutions += 1;
      return {};
    },
  };

  const executor = new GuardedPinAIRuntimeToolExecutor(delegate);
  const memory = createConversationMemory(request);

  for (const tool of [
    "calculate_extension_price",
    "check_date_change",
    "get_cancellation_policy",
    "get_payment_context",
    "search_local_places",
  ] as const) {
    await assert.rejects(
      executor.execute(tool, {}, request, memory),
      new RegExp(`PIN_AI_RUNTIME_TOOL_NOT_ENABLED:${tool}`),
    );
  }

  assert.equal(delegateExecutions, 0);
});
