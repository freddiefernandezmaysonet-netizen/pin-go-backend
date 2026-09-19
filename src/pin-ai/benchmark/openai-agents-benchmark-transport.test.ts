import assert from "node:assert/strict";
import test from "node:test";

import type { AgentsApiSessionRequest } from "./openai-agents-benchmark-adapter.js";
import {
  OpenAIAgentsBenchmarkTransport,
  type BenchmarkFetch,
} from "./openai-agents-benchmark-transport.js";

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

  await assert.rejects(transport.createSession(request), /PIN_AI_BENCHMARK_DISABLED/);
  assert.equal(fetchCalled, false);
});

test("OpenAI benchmark transport requires an explicit API key", async () => {
  const fetchImpl: BenchmarkFetch = async () => {
    throw new Error("unexpected fetch");
  };
  const transport = new OpenAIAgentsBenchmarkTransport({ enabled: true }, fetchImpl);

  await assert.rejects(
    transport.createSession(request),
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
    transport.createSession({
      ...request,
      metadata: { ...request.metadata, organization_id: "real-org" },
    }),
    /PIN_AI_BENCHMARK_TENANT_SCOPE_BLOCKED/,
  );
  assert.equal(fetchCalled, false);
});

test("OpenAI benchmark transport sends only to configured Agents session endpoint", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  const fetchImpl: BenchmarkFetch = async (url, init) => {
    capturedUrl = url;
    capturedAuthorization = init.headers.authorization;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          output_text: "Benchmark response",
          usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 },
        };
      },
    };
  };
  const transport = new OpenAIAgentsBenchmarkTransport(
    {
      enabled: true,
      apiKey: "benchmark-test-key",
      baseUrl: "https://api.openai.com",
    },
    fetchImpl,
  );

  const result = await transport.createSession(request);

  assert.equal(capturedUrl, "https://api.openai.com/v1/agents/sessions");
  assert.equal(capturedAuthorization, "Bearer benchmark-test-key");
  assert.equal(result.scenarioId, "001");
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.responseText, "Benchmark response");
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
  });
});
