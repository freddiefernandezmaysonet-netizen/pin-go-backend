import assert from "node:assert/strict";
import test from "node:test";

import type { PinAIRuntimeRequest } from "./contracts.js";
import { createConversationMemory } from "./conversation-memory.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
    currentLocalDateTime: "2026-09-20T11:00:00-04:00",
    preferredLanguage: "en",
  },
  conversation: [
    {
      role: "guest",
      content: "The AC still isn't cooling after the reset.",
    },
  ],
};

test("Luna runtime adapter executes read tools but shadows escalation", async () => {
  let accessToolExecutions = 0;
  let escalationExecutions = 0;
  const responses = [
    {
      id: "sess_1",
      status: "requires_action",
      required_actions: [
        {
          type: "function_call",
          turn_id: "turn_1",
          call_id: "call_1",
          name: "get_property_knowledge",
          arguments: {},
        },
        {
          type: "function_call",
          turn_id: "turn_1",
          call_id: "call_2",
          name: "escalate_to_host",
          arguments: {},
        },
      ],
    },
    {},
    {},
    {
      id: "sess_1",
      status: "idle",
      required_actions: [],
    },
    {
      data: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "I checked the property guidance and would escalate this for review.",
            },
          ],
        },
      ],
    },
  ];

  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      pollDelayMs: 0,
    },
    async () => {
      const payload = responses.shift();
      if (payload === undefined) {
        throw new Error("UNEXPECTED_FETCH");
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
  );

  const tools: PinAIRuntimeToolExecutor = {
    async execute(tool) {
      if (tool === "get_property_knowledge") {
        accessToolExecutions += 1;
        return { acGuidance: "Escalate after exhausted reset." };
      }
      if (tool === "escalate_to_host") {
        escalationExecutions += 1;
      }
      return {};
    },
  };

  const adapter = new LunaRuntimeAdapter(transport);
  const result = await adapter.run(
    request,
    createConversationMemory(request),
    tools,
  );

  assert.equal(accessToolExecutions, 1);
  assert.equal(escalationExecutions, 0);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.escalationCreated, false);
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["get_property_knowledge", "escalate_to_host"],
  );
  assert.match(result.responseText, /would escalate/i);
});

test("runtime transport fails closed when OpenAI runtime is disabled", async () => {
  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: false,
      apiKey: "test-key",
      model: "gpt-5.6-luna",
    },
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {};
      },
    }),
  );

  const adapter = new LunaRuntimeAdapter(transport);
  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      return {};
    },
  };

  await assert.rejects(
    adapter.run(request, createConversationMemory(request), tools),
    /PIN_AI_RUNTIME_OPENAI_DISABLED/,
  );
});
