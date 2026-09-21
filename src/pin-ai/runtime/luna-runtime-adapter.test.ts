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

test("runtime preserves safe structured diagnostics from a failed OpenAI session", async () => {
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
          id: "sess_failed",
          status: "failed",
          required_actions: [],
          error: {
            type: "server_error",
            code: "agent_internal_error",
            message: "An internal error occurred.",
          },
        };
      },
    }),
  );

  await assert.rejects(
    new LunaRuntimeAdapter(transport).run(
      request,
      createConversationMemory(request),
      { async execute() { return {}; } },
    ),
    /PIN_AI_RUNTIME_AGENT_SESSION_FAILED:type=server_error;code=agent_internal_error;message=An internal error occurred\./,
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
      agentId: "agent_saved123",
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
    agent_id: string;
    agent: { instructions: string; tools: Array<{ name: string }> };
  };

  assert.equal(sessionPayload.agent_id, "agent_saved123");
  assert.match(
    sessionPayload.agent.instructions,
    /extension pricing as an estimate for review only/i,
  );
  assert.match(
    sessionPayload.agent.instructions,
    /date-change availability and pricing as an estimate for host review only/i,
  );
  assert.match(
    sessionPayload.agent.instructions,
    /cancellation-policy results and refund amounts as read-only estimates/i,
  );
  assert.match(
    sessionPayload.agent.instructions,
    /payment context as read-only persisted history only/i,
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
      "get_cancellation_policy",
      "get_payment_context",
      "escalate_to_host",
    ],
  );
});

test("runtime advertises native web search separately without exposing hidden functions", async () => {
  let createSessionBody = "";
  const responses = [
    {
      id: "sess_web_search_tools",
      status: "idle",
      required_actions: [],
    },
    {
      data: [
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Two current options." }],
        },
      ],
    },
  ];

  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      webSearch: {
        enabled: true,
        mode: "live",
        location: {
          country: "PR",
          region: "Puerto Rico",
          city: "San Juan",
          timezone: "America/Puerto_Rico",
        },
      },
      pollDelayMs: 0,
    },
    async (_input, init) => {
      if (init.method === "POST" && init.body && createSessionBody === "") {
        createSessionBody = init.body;
      }
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

  const result = await new LunaRuntimeAdapter(transport).run(
    request,
    createConversationMemory(request),
    { async execute() { return {}; } },
  );
  const sessionPayload = JSON.parse(createSessionBody) as {
    agent: {
      tools: Array<{
        type: string;
        name?: string;
        mode?: string;
        location?: Readonly<Record<string, string>>;
      }>;
    };
  };

  assert.deepEqual(sessionPayload.agent.tools[0], {
    type: "web_search",
    mode: "live",
    location: {
      country: "PR",
      region: "Puerto Rico",
      city: "San Juan",
      timezone: "America/Puerto_Rico",
    },
  });
  assert.equal(
    sessionPayload.agent.tools.some(
      (tool) => tool.type === "function" && tool.name === "search_local_places",
    ),
    false,
  );
  assert.equal(
    sessionPayload.agent.tools.filter((tool) => tool.type === "function").length,
    12,
  );
  assert.deepEqual(result.webSearch, {
    enabled: true,
    used: true,
    callCount: 1,
  });
});

test("runtime continues an idle OpenAI session and returns only the latest turn", async () => {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const responses = [
    { id: "session_conversation", status: "idle", required_actions: [] },
    {},
    { id: "session_conversation", status: "idle", required_actions: [] },
    {
      data: [
        { type: "message", role: "user", content: [] },
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Earlier answer." }],
        },
        { type: "message", role: "user", content: [] },
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Latest answer." }],
        },
      ],
    },
  ];
  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey: "test-key",
      agentId: "agent_saved123",
      resumeSessionId: "session_conversation",
      model: "gpt-5.6-luna",
      webSearch: { enabled: true, mode: "live" },
      pollDelayMs: 0,
    },
    async (url, init) => {
      calls.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}) });
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

  const result = await new LunaRuntimeAdapter(transport).run(
    request,
    createConversationMemory(request),
    { async execute() { return {}; } },
  );

  assert.equal(calls.some((call) => call.url.endsWith("/v1/agents/sessions")), false);
  const messageEvent = calls.find(
    (call) => call.method === "POST" && call.url.endsWith("/events"),
  );
  const eventPayload = JSON.parse(messageEvent?.body ?? "{}") as {
    events?: Array<{
      type?: string;
      input?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    }>;
  };
  assert.equal(eventPayload.events?.[0]?.type, "agent.session.input.message");
  assert.equal(eventPayload.events?.[0]?.input?.[0]?.content?.[0]?.type, "input_text");
  assert.match(
    eventPayload.events?.[0]?.input?.[0]?.content?.[0]?.text ?? "",
    /The AC still isn't cooling/,
  );
  assert.equal(result.openaiSessionId, "session_conversation");
  assert.equal(result.responseText, "Latest answer.");
  assert.deepEqual(result.webSearch, {
    enabled: true,
    used: true,
    callCount: 1,
  });
});

test("runtime preserves read-only function calls and native web search evidence in one session", async () => {
  let toolExecutions = 0;
  const responses = [
    {
      id: "sess_web_search_with_function",
      status: "requires_action",
      required_actions: [
        {
          type: "function_call",
          turn_id: "turn_web_search_with_function",
          call_id: "call_web_search_with_function",
          name: "check_late_checkout",
          arguments: { requestedLocalTime: "13:00" },
        },
      ],
    },
    {},
    {
      id: "sess_web_search_with_function",
      status: "idle",
      required_actions: [],
    },
    {
      data: [
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "The late checkout is available for review, and here are current public restaurant options.",
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
      webSearch: { enabled: true, mode: "live" },
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

  const result = await new LunaRuntimeAdapter(transport).run(
    request,
    createConversationMemory(request),
    {
      async execute(tool, args) {
        toolExecutions += 1;
        assert.equal(tool, "check_late_checkout");
        assert.deepEqual(args, { requestedLocalTime: "13:00" });
        return {
          decision: "OPERATIONALLY_AVAILABLE_FOR_REVIEW",
          authorizationGranted: false,
        };
      },
    },
  );

  assert.equal(toolExecutions, 1);
  assert.deepEqual(result.toolCalls, [
    {
      name: "check_late_checkout",
      arguments: { requestedLocalTime: "13:00" },
    },
  ]);
  assert.deepEqual(result.webSearch, {
    enabled: true,
    used: true,
    callCount: 1,
  });
  assert.equal(result.escalationCreated, false);
  assert.equal(result.requiresHumanReview, true);
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
              name: "search_local_places",
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
    /PIN_AI_RUNTIME_UNAPPROVED_TOOL:search_local_places/,
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
