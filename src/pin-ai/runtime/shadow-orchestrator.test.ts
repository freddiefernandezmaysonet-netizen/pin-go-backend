import assert from "node:assert/strict";
import test from "node:test";

import type {
  PinAIRuntimeRequest,
} from "./contracts.js";
import {
  GuardedPinAIModelAdapter,
  type PinAIModelAdapter,
} from "./model-adapter.js";
import {
  PinAIShadowOrchestrator,
} from "./shadow-orchestrator.js";
import type {
  PinAIRuntimeToolExecutor,
} from "./tool-executor.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
    currentLocalDateTime: "2026-09-20T10:30:00-04:00",
    preferredLanguage: "en",
  },
  conversation: [
    {
      role: "guest",
      content: "The AC is still not cooling after the reset.",
    },
  ],
};

test("guarded model adapter rejects unsafe runtime output", async () => {
  const unsafeModel: PinAIModelAdapter = {
    async run() {
      return {
        responseText: "Unsafe",
        toolCalls: [
          {
            name: "get_access_status",
            arguments: {
              activePasscode: "123456",
            },
          },
        ],
        escalationCreated: false,
        requiresHumanReview: false,
      };
    },
  };

  const guarded = new GuardedPinAIModelAdapter(unsafeModel);

  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      return {};
    },
  };

  await assert.rejects(
    guarded.run(
      request,
      {
        organizationId: "org-a",
        propertyId: "property-a",
        reservationId: "reservation-a",
        guestId: "guest-a",
        facts: {},
        issues: [],
        attemptedTroubleshooting: [],
        completedToolChecks: [],
      },
      tools,
    ),
    /PIN_AI_RUNTIME_FORBIDDEN_FIELD/,
  );
});

test("shadow orchestrator returns proposed response without executing actions", async () => {
  let toolExecutionCount = 0;

  const model: PinAIModelAdapter = {
    async run() {
      return {
        responseText: "I would escalate this for maintenance review.",
        toolCalls: [
          {
            name: "escalate_to_host",
            arguments: {
              priority: "URGENT",
            },
          },
        ],
        escalationCreated: false,
        requiresHumanReview: true,
      };
    },
  };

  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      toolExecutionCount += 1;
      return {};
    },
  };

  const orchestrator = new PinAIShadowOrchestrator(
    new GuardedPinAIModelAdapter(model),
    tools,
  );

  const result = await orchestrator.run(request);

  assert.equal(result.mode, "SHADOW");
  assert.equal(result.actionsExecuted, false);
  assert.equal(toolExecutionCount, 0);
  assert.equal(result.response.requiresHumanReview, true);
  assert.deepEqual(
    result.response.toolCalls.map((call) => call.name),
    ["escalate_to_host"],
  );
});

test("shadow mode preserves stay-scoped memory", async () => {
  const model: PinAIModelAdapter = {
    async run(_request, memory) {
      assert.equal(memory.organizationId, "org-a");
      assert.equal(memory.propertyId, "property-a");
      assert.equal(memory.reservationId, "reservation-a");
      assert.equal(memory.guestId, "guest-a");

      return {
        responseText: "Acknowledged.",
        toolCalls: [],
        escalationCreated: false,
        requiresHumanReview: false,
      };
    },
  };

  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      return {};
    },
  };

  const orchestrator = new PinAIShadowOrchestrator(
    new GuardedPinAIModelAdapter(model),
    tools,
  );

  const result = await orchestrator.run(request);

  assert.equal(result.memory.reservationId, "reservation-a");
});
