import assert from "node:assert/strict";
import test from "node:test";

import type {
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";
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

async function runSingleToolResult(
  toolName: PinAIRuntimeToolName,
  output: Readonly<Record<string, unknown>>,
) {
  const responses = [
    {
      id: "sess_review_metadata",
      status: "requires_action",
      required_actions: [
        {
          type: "function_call",
          turn_id: "turn_review_metadata",
          call_id: "call_review_metadata",
          name: toolName,
          arguments: {},
        },
      ],
    },
    {},
    {
      id: "sess_review_metadata",
      status: "idle",
      required_actions: [],
    },
    {
      data: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Checked." }],
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
      if (payload === undefined) throw new Error("UNEXPECTED_FETCH");
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
  );

  return new LunaRuntimeAdapter(transport).run(
    request,
    createConversationMemory(request),
    {
      async execute(tool) {
        assert.equal(tool, toolName);
        return output;
      },
    },
  );
}

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

test("runtime marks review metadata from eligibility and pricing decisions", async () => {
  for (const testCase of [
    {
      tool: "check_late_checkout",
      output: { decision: "OPERATIONALLY_AVAILABLE_FOR_REVIEW" },
    },
    {
      tool: "calculate_extension_price",
      output: { decision: "PRICE_CALCULATED_FOR_REVIEW" },
    },
    {
      tool: "calculate_extension_price",
      output: {
        decision: "PRICE_REQUIRES_HUMAN_REVIEW",
        pricingReviewRequired: true,
      },
    },
    {
      tool: "check_date_change",
      output: { decision: "DATE_CHANGE_AVAILABLE_FOR_REVIEW" },
    },
    {
      tool: "get_property_knowledge",
      output: { requiresHumanReview: true },
    },
  ] as const) {
    const result = await runSingleToolResult(testCase.tool, testCase.output);
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.escalationCreated, false);
  }
});

test("runtime does not mark unavailable eligibility as human review", async () => {
  const result = await runSingleToolResult("check_extension_availability", {
    decision: "NOT_AVAILABLE",
    authorizationGranted: false,
  });

  assert.equal(result.requiresHumanReview, false);
  assert.equal(result.escalationCreated, false);
});

test("runtime advertises exactly the enabled Runtime V1 tools to Luna", async () => {
  let createSessionBody = "";

  const responses = [
    {
      id: "sess_tools",
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
              text: "Checked.",
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
    async (_input, init) => {
      if (init.method === "POST" && init.body && createSessionBody === "") {
        createSessionBody = init.body;
      }

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
    async execute() {
      return {};
    },
  };

  const adapter = new LunaRuntimeAdapter(transport);
  await adapter.run(request, createConversationMemory(request), tools);

  const sessionPayload = JSON.parse(createSessionBody) as {
    agent: { instructions: string; tools: Array<{ name: string }> };
  };

  assert.match(
    sessionPayload.agent.instructions,
    /extension pricing as an estimate for review only/i,
  );
  assert.match(
    sessionPayload.agent.instructions,
    /date-change availability and pricing as an estimate for host review only/i,
  );

  assert.deepEqual(
    sessionPayload.agent.tools.map((tool) => tool.name),
    [
      "get_property_knowledge",
      "get_reservation_context",
      "get_access_status",
      "get_cleaning_status",
      "check_early_checkin",
      "check_late_checkout",
      "check_extension_availability",
      "calculate_extension_price",
      "check_date_change",
      "escalate_to_host",
    ],
  );
});

test("runtime rejects a disabled tool returned by Luna before execution", async () => {
  let toolExecutions = 0;

  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      pollDelayMs: 0,
    },
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: "sess_disabled_tool",
          status: "requires_action",
          required_actions: [
            {
              type: "function_call",
              turn_id: "turn_disabled_tool",
              call_id: "call_disabled_tool",
              name: "get_cancellation_policy",
              arguments: {},
            },
          ],
        };
      },
    }),
  );

  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      toolExecutions += 1;
      return {};
    },
  };

  const adapter = new LunaRuntimeAdapter(transport);

  await assert.rejects(
    adapter.run(request, createConversationMemory(request), tools),
    /PIN_AI_RUNTIME_UNAPPROVED_TOOL:get_cancellation_policy/,
  );
  assert.equal(toolExecutions, 0);
});

test("runtime rejects non-object tool arguments before execution", async () => {
  let toolExecutions = 0;
  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      toolExecutions += 1;
      throw new Error("TOOL_SHOULD_NOT_EXECUTE");
    },
  };

  for (const invalidArguments of [null, "{}", []]) {
    const transport = new OpenAIAgentsRuntimeTransport(
      {
        enabled: true,
        apiKey: "test-key",
        model: "gpt-5.6-luna",
        pollDelayMs: 0,
      },
      async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            id: "sess_invalid_args",
            status: "requires_action",
            required_actions: [
              {
                type: "function_call",
                turn_id: "turn_invalid_args",
                call_id: "call_invalid_args",
                name: "check_late_checkout",
                arguments: invalidArguments,
              },
            ],
          };
        },
      }),
    );

    await assert.rejects(
      new LunaRuntimeAdapter(transport).run(
        request,
        createConversationMemory(request),
        tools,
      ),
      /PIN_AI_RUNTIME_TOOL_ARGUMENTS_INVALID/,
    );
  }
  assert.equal(toolExecutions, 0);
});

test("runtime rejects a repeated call id before duplicate execution", async () => {
  let toolExecutions = 0;
  const repeatedActionSession = {
    id: "sess_duplicate_call",
    status: "requires_action",
    required_actions: [
      {
        type: "function_call",
        turn_id: "turn_duplicate_call",
        call_id: "call_duplicate",
        name: "get_access_status",
        arguments: {},
      },
    ],
  };

  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      pollDelayMs: 0,
      maxPolls: 2,
    },
    async (input, init) => ({
      ok: true,
      status: 200,
      async json() {
        if (init.method === "POST" && input.endsWith("/events")) return {};
        return repeatedActionSession;
      },
    }),
  );

  const tools: PinAIRuntimeToolExecutor = {
    async execute() {
      toolExecutions += 1;
      return { accessStatus: "ACTIVE" };
    },
  };

  await assert.rejects(
    new LunaRuntimeAdapter(transport).run(
      request,
      createConversationMemory(request),
      tools,
    ),
    /PIN_AI_RUNTIME_DUPLICATE_TOOL_CALL_ID:call_duplicate/,
  );
  assert.equal(toolExecutions, 1);
});
