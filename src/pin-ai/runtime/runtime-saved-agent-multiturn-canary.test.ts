import assert from "node:assert/strict";
import test from "node:test";

import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";
import {
  assertSavedAgentMultiTurnCanaryEnvironment,
  runSavedAgentMultiTurnCanary,
} from "./runtime-saved-agent-multiturn-canary.js";

const context = {
  organizationId: "org-a",
  propertyId: "property-a",
  reservationId: "reservation-a",
  preferredLanguage: "en" as const,
  currentLocalDateTime: "2026-09-24T11:00:00-04:00",
};

test("multi-turn canary fails closed unless every shadow guard is explicit", () => {
  const valid = {
    PIN_AI_RUNTIME_MULTITURN_CANARY_ENABLED: "true",
    PIN_AI_RUNTIME_SHADOW_ENABLED: "true",
    PIN_AI_RUNTIME_REAL_READ_ENABLED: "true",
    PIN_AI_OPENAI_AGENT_ID: "agent_test123",
    OPENAI_API_KEY: "test-key",
  };

  assert.deepEqual(assertSavedAgentMultiTurnCanaryEnvironment(valid), {
    apiKey: "test-key",
    agentId: "agent_test123",
  });

  assert.throws(
    () =>
      assertSavedAgentMultiTurnCanaryEnvironment({
        ...valid,
        PIN_AI_RUNTIME_MULTITURN_CANARY_ENABLED: "false",
      }),
    /PIN_AI_RUNTIME_MULTITURN_CANARY_DISABLED/,
  );

  assert.throws(
    () =>
      assertSavedAgentMultiTurnCanaryEnvironment({
        ...valid,
        PIN_AI_RUNTIME_WEB_SEARCH_ENABLED: "true",
      }),
    /PIN_AI_RUNTIME_MULTITURN_WEB_SEARCH_MUST_BE_DISABLED/,
  );

  assert.throws(
    () =>
      assertSavedAgentMultiTurnCanaryEnvironment({
        ...valid,
        PIN_AI_OPENAI_AGENT_ID: "not-an-agent",
      }),
    /PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING_OR_INVALID/,
  );
});

test("multi-turn canary creates one saved-agent session and resumes it for turn two", async () => {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  let itemsRead = 0;
  let toolExecutions = 0;

  const fetchImpl = async (
    url: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    calls.push({
      method: init.method,
      url,
      ...(init.body ? { body: init.body } : {}),
    });

    if (init.method === "POST" && url.endsWith("/v1/agents/sessions")) {
      return response({
        id: "session_shared",
        status: "requires_action",
        required_actions: [
          {
            type: "function_call",
            turn_id: "turn_first",
            call_id: "call_first",
            name: "get_reservation_context",
            arguments: {},
          },
        ],
      });
    }

    if (init.method === "POST" && url.endsWith("/events")) {
      return response({});
    }

    if (init.method === "GET" && url.endsWith("/items?limit=100&order=asc")) {
      itemsRead += 1;
      return response(
        itemsRead === 1
          ? {
              data: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "Your stay is active. The next milestone is access readiness.",
                    },
                  ],
                },
              ],
            }
          : {
              data: [
                { type: "message", role: "user", content: [] },
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "Your stay is active. The next milestone is access readiness.",
                    },
                  ],
                },
                { type: "message", role: "user", content: [] },
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "PIN-AI-ORBIT-47",
                    },
                  ],
                },
              ],
            },
      );
    }

    if (init.method === "GET" && url.includes("/v1/agents/sessions/session_shared")) {
      return response({
        id: "session_shared",
        status: "idle",
        required_actions: [],
      });
    }

    throw new Error(`UNEXPECTED_FETCH:${init.method}:${url}`);
  };

  const tools: PinAIRuntimeToolExecutor = {
    async execute(tool) {
      toolExecutions += 1;
      assert.equal(tool, "get_reservation_context");
      return {
        reservationStatus: "ACTIVE",
        accessReady: false,
      };
    },
  };

  const result = await runSavedAgentMultiTurnCanary({
    apiKey: "test-key",
    agentId: "agent_saved123",
    context,
    fetchImpl,
    tools,
  });

  assert.equal(result.sessionId, "session_shared");
  assert.equal(result.actionsExecuted, false);
  assert.equal(result.databaseWrites, false);
  assert.equal(result.operationalWrites, false);
  assert.equal(result.escalationCreated, false);
  assert.equal(result.webSearchUsed, false);
  assert.equal(result.semanticContinuity, true);
  assert.deepEqual(result.firstTurn.toolCalls, ["get_reservation_context"]);
  assert.deepEqual(result.secondTurn.toolCalls, []);
  assert.equal(result.firstTurn.responseLength > 0, true);
  assert.equal(result.secondTurn.responseLength > 0, true);
  assert.equal(toolExecutions, 1);

  const createCalls = calls.filter(
    (call) =>
      call.method === "POST" &&
      call.url.endsWith("/v1/agents/sessions"),
  );
  assert.equal(createCalls.length, 1);

  const createPayload = JSON.parse(createCalls[0]?.body ?? "{}") as {
    agent_id?: string;
    agent?: {
      tools?: Array<{ type?: string; name?: string }>;
    };
  };
  assert.equal(createPayload.agent_id, "agent_saved123");
  assert.equal(
    createPayload.agent?.tools?.filter((tool) => tool.type === "function").length,
    13,
  );
  assert.equal(
    createPayload.agent?.tools?.some((tool) => tool.type === "web_search"),
    false,
  );
  assert.equal(
    createPayload.agent?.tools?.some(
      (tool) => tool.name === "search_local_places",
    ),
    false,
  );

  const messageEvents = calls
    .filter(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith("/v1/agents/sessions/session_shared/events"),
    )
    .map((call) => JSON.parse(call.body ?? "{}") as {
      events?: Array<{
        type?: string;
        input?: Array<{
          content?: Array<{ text?: string }>;
        }>;
      }>;
    })
    .filter(
      (payload) =>
        payload.events?.[0]?.type === "agent.session.input.message",
    );

  assert.equal(messageEvents.length, 1);
  assert.match(
    messageEvents[0]?.events?.[0]?.input?.[0]?.content?.[0]?.text ?? "",
    /What code did I give you in my previous message\?/,
  );
});

test("multi-turn canary fails if OpenAI returns a different session on turn two", async () => {
  let itemReads = 0;
  let sessionReads = 0;

  const fetchImpl = async (
    url: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    if (init.method === "POST" && url.endsWith("/v1/agents/sessions")) {
      return response({
        id: "session_original",
        status: "idle",
        required_actions: [],
      });
    }

    if (init.method === "POST" && url.endsWith("/events")) {
      return response({});
    }

    if (init.method === "GET" && url.endsWith("/items?limit=100&order=asc")) {
      itemReads += 1;
      return response({
        data: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  itemReads === 1
                    ? "First answer."
                    : "PIN-AI-ORBIT-47",
              },
            ],
          },
        ],
      });
    }

    if (
      init.method === "GET" &&
      (url.includes("/v1/agents/sessions/session_original") ||
        url.includes("/v1/agents/sessions/session_changed"))
    ) {
      sessionReads += 1;
      return response({
        id: "session_changed",
        status: "idle",
        required_actions: [],
      });
    }

    throw new Error(`UNEXPECTED_FETCH:${init.method}:${url}`);
  };

  await assert.rejects(
    runSavedAgentMultiTurnCanary({
      apiKey: "test-key",
      agentId: "agent_saved123",
      context,
      fetchImpl,
      tools: { async execute() { return {}; } },
    }),
    /PIN_AI_RUNTIME_MULTITURN_SESSION_ID_CHANGED/,
  );
});

test("multi-turn canary fails closed when turn two cannot recall the semantic marker", async () => {
  let itemReads = 0;

  const fetchImpl = async (
    url: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    if (init.method === "POST" && url.endsWith("/v1/agents/sessions")) {
      return response({
        id: "session_semantic",
        status: "idle",
        required_actions: [],
      });
    }

    if (init.method === "POST" && url.endsWith("/events")) {
      return response({});
    }

    if (init.method === "GET" && url.endsWith("/items?limit=100&order=asc")) {
      itemReads += 1;
      return response({
        data: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  itemReads === 1
                    ? "First answer."
                    : "I do not remember the code.",
              },
            ],
          },
        ],
      });
    }

    if (
      init.method === "GET" &&
      url.includes("/v1/agents/sessions/session_semantic")
    ) {
      return response({
        id: "session_semantic",
        status: "idle",
        required_actions: [],
      });
    }

    throw new Error(`UNEXPECTED_FETCH:${init.method}:${url}`);
  };

  await assert.rejects(
    runSavedAgentMultiTurnCanary({
      apiKey: "test-key",
      agentId: "agent_saved123",
      context,
      fetchImpl,
      tools: { async execute() { return {}; } },
    }),
    /PIN_AI_RUNTIME_MULTITURN_SEMANTIC_CONTINUITY_FAILED/,
  );
});

function response(payload: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}
