import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkScenario } from "./contracts.js";
import { FixtureMockToolExecutor } from "./mock-tool-executor.js";
import type { AgentsApiSessionRequest } from "./openai-agents-benchmark-adapter.js";
import {
  OpenAIAgentsBenchmarkTransport,
  type BenchmarkFetch,
} from "./openai-agents-benchmark-transport.js";

const scenario: BenchmarkScenario = {
  id: "001",
  title: "Transport loop test",
  category: "ARRIVAL_ACCESS",
  context: {
    organizationId: "benchmark-org-a",
    propertyId: "benchmark-property-a",
    reservationId: "benchmark-reservation-a",
    guestId: "benchmark-guest-a",
    currentLocalDateTime: "2026-09-19T14:47:00-04:00",
    reservationStatus: "CONFIRMED",
    checkInLocal: "2026-09-19T16:00:00-04:00",
    checkOutLocal: "2026-09-22T11:00:00-04:00",
    identityStatus: "VERIFIED",
    agreementsStatus: "COMPLETE",
    cleaningStatus: "IN_PROGRESS",
    accessStatus: "SCHEDULED",
    accessStartsAtLocal: "2026-09-19T16:00:00-04:00",
    maxGuests: 4,
    bookedGuestCount: 2,
  },
  conversation: [{ role: "guest", content: "The code is not working. We arrived early." }],
  expectation: {
    intents: ["EARLY_ARRIVAL"],
    requiredTools: ["get_access_status"],
    requiredBehaviors: ["check access state"],
    forbiddenBehaviors: ["invent access"],
  },
};

const request: AgentsApiSessionRequest = {
  environment: { type: "none" },
  agent: {
    model: "gpt-5.6-luna",
    instructions: "benchmark only",
    tools: [],
  },
  input: "{}",
  metadata: {
    benchmark: "true",
    scenario_id: "001",
    organization_id: "benchmark-org-a",
  },
};

const tools = new FixtureMockToolExecutor({
  get_access_status: {
    accessStatus: "SCHEDULED",
    accessStartsAtLocal: "2026-09-19T16:00:00-04:00",
  },
});

test("OpenAI benchmark transport is default-off", async () => {
  let fetchCalled = false;
  const fetchImpl: BenchmarkFetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };
  const transport = new OpenAIAgentsBenchmarkTransport(
    { enabled: false, apiKey: "not-a-real-key" },
    fetchImpl,
  );

  await assert.rejects(
    transport.runSession(request, scenario, tools),
    /PIN_AI_BENCHMARK_DISABLED/,
  );
  assert.equal(fetchCalled, false);
});

test("OpenAI benchmark transport requires an explicit API key", async () => {
  const fetchImpl: BenchmarkFetch = async () => {
    throw new Error("unexpected fetch");
  };
  const transport = new OpenAIAgentsBenchmarkTransport({ enabled: true }, fetchImpl);

  await assert.rejects(
    transport.runSession(request, scenario, tools),
    /PIN_AI_BENCHMARK_OPENAI_API_KEY_MISSING/,
  );
});

test("OpenAI benchmark transport blocks non-benchmark tenant metadata before network", async () => {
  let fetchCalled = false;
  const fetchImpl: BenchmarkFetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };
  const transport = new OpenAIAgentsBenchmarkTransport(
    { enabled: true, apiKey: "not-a-real-key" },
    fetchImpl,
  );

  await assert.rejects(
    transport.runSession(
      {
        ...request,
        metadata: { ...request.metadata, organization_id: "real-org" },
      },
      scenario,
      tools,
    ),
    /PIN_AI_BENCHMARK_TENANT_SCOPE_BLOCKED/,
  );
  assert.equal(fetchCalled, false);
});

test("OpenAI benchmark transport extracts assistant output from session items", async () => {
  const calls: Array<{ url: string; method: string; beta: string }> = [];
  const fetchImpl: BenchmarkFetch = async (url, init) => {
    calls.push({ url, method: init.method, beta: init.headers["OpenAI-Beta"] ?? "" });

    if (url.endsWith("/v1/agents/sessions") && init.method === "POST") {
      return jsonResponse({
        id: "session_001",
        status: "idle",
        required_actions: [],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 30,
        },
      });
    }

    if (url.includes("/v1/agents/sessions/session_001/items")) {
      return jsonResponse({
        object: "list",
        data: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Your access starts at 4:00 PM." }],
          },
        ],
      });
    }

    throw new Error(`unexpected fetch: ${init.method} ${url}`);
  };

  const transport = new OpenAIAgentsBenchmarkTransport(
    {
      enabled: true,
      apiKey: "benchmark-test-key",
      baseUrl: "https://api.openai.com",
      pollDelayMs: 0,
    },
    fetchImpl,
  );

  const result = await transport.runSession(request, scenario, tools);

  assert.equal(result.responseText, "Your access starts at 4:00 PM.");
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
  });
  assert.equal(result.toolCalls.length, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.beta === "agents=v1"));
});

test("OpenAI benchmark transport executes required mock function and submits tool result", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: BenchmarkFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });

    if (url.endsWith("/v1/agents/sessions") && init.method === "POST") {
      return jsonResponse({
        id: "session_tool",
        status: "requires_action",
        required_actions: [
          {
            type: "function_call",
            turn_id: "turn_1",
            call_id: "call_1",
            name: "get_access_status",
            arguments: {},
          },
        ],
        usage: null,
      });
    }

    if (url.endsWith("/v1/agents/sessions/session_tool/events") && init.method === "POST") {
      assert.ok(init.body);
      const body = JSON.parse(init.body);
      assert.equal(body.events[0].type, "agent.session.input.tool_result");
      assert.equal(body.events[0].turn_id, "turn_1");
      assert.equal(body.events[0].call_id, "call_1");
      assert.equal(body.events[0].success, true);
      assert.match(body.events[0].output, /SCHEDULED/);
      return jsonResponse({});
    }

    if (url.endsWith("/v1/agents/sessions/session_tool") && init.method === "GET") {
      return jsonResponse({
        id: "session_tool",
        status: "idle",
        required_actions: [],
        usage: {
          input_tokens: 200,
          input_tokens_details: { cached_tokens: 50 },
          output_tokens: 40,
        },
      });
    }

    if (url.includes("/v1/agents/sessions/session_tool/items")) {
      return jsonResponse({
        object: "list",
        data: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Your access is scheduled for 4:00 PM." }],
          },
        ],
      });
    }

    throw new Error(`unexpected fetch: ${init.method} ${url}`);
  };

  const transport = new OpenAIAgentsBenchmarkTransport(
    {
      enabled: true,
      apiKey: "benchmark-test-key",
      baseUrl: "https://api.openai.com",
      pollDelayMs: 0,
    },
    fetchImpl,
  );

  const result = await transport.runSession(request, scenario, tools);

  assert.equal(result.responseText, "Your access is scheduled for 4:00 PM.");
  assert.deepEqual(result.toolCalls, [{ name: "get_access_status", arguments: {} }]);
  assert.equal(calls.length, 5);
});

test("OpenAI benchmark transport sanitizes error diagnostics and redacts keys", async () => {
  const fetchImpl: BenchmarkFetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return {
        error: {
          type: "invalid_request_error",
          code: "invalid_api_key",
          message: "Invalid key sk-secret-example\nBearer token-secret",
        },
      };
    },
  });
  const transport = new OpenAIAgentsBenchmarkTransport(
    { enabled: true, apiKey: "benchmark-test-key" },
    fetchImpl,
  );

  await assert.rejects(
    transport.runSession(request, scenario, tools),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP_401:invalid_request_error:invalid_api_key/);
      assert.match(error.message, /\[REDACTED_KEY\]/);
      assert.doesNotMatch(error.message, /sk-secret-example/);
      assert.doesNotMatch(error.message, /token-secret/);
      return true;
    },
  );
});

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

test("OpenAI benchmark transport falls back to completed turn usage when session usage is zero", async () => {
  const fetchImpl: BenchmarkFetch = async (url, init) => {
    if (url.endsWith("/v1/agents/sessions") && init.method === "POST") {
      return jsonResponse({
        id: "session_usage",
        status: "idle",
        required_actions: [],
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
        },
      });
    }
    if (url.includes("/v1/agents/sessions/session_usage/items")) {
      return jsonResponse({
        object: "list",
        data: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        }],
      });
    }
    if (url.includes("/v1/agents/sessions/session_usage/turns")) {
      return jsonResponse({
        object: "list",
        data: [{
          id: "turn_usage",
          usage: {
            input_tokens: 333,
            input_tokens_details: { cached_tokens: 111 },
            output_tokens: 44,
          },
        }],
      });
    }
    throw new Error(`unexpected fetch: ${init.method} ${url}`);
  };

  const transport = new OpenAIAgentsBenchmarkTransport(
    { enabled: true, apiKey: "benchmark-test-key", pollDelayMs: 0 },
    fetchImpl,
  );

  const result = await transport.runSession(request, scenario, tools);
  assert.deepEqual(result.usage, {
    inputTokens: 333,
    cachedInputTokens: 111,
    outputTokens: 44,
  });
});
