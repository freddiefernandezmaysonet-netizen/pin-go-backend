import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkScenario } from "./contracts.js";
import {
  OPENAI_AGENTS_BENCHMARK_TOOLS,
  OpenAIAgentsBenchmarkAdapter,
  type AgentsApiSessionRequest,
  type AgentsApiTransport,
} from "./openai-agents-benchmark-adapter.js";

const scenario: BenchmarkScenario = {
  id: "adapter-test-001",
  title: "OpenAI adapter isolation",
  category: "GROUNDING",
  context: {
    organizationId: "benchmark-org-adapter",
    propertyId: "benchmark-property-adapter",
    reservationId: "benchmark-reservation-adapter",
    guestId: "benchmark-guest-adapter",
    currentLocalDateTime: "2026-09-19T10:00:00-04:00",
    reservationStatus: "ACTIVE",
    checkInLocal: "2026-09-19T16:00:00-04:00",
    checkOutLocal: "2026-09-22T11:00:00-04:00",
    identityStatus: "VERIFIED",
    agreementsStatus: "COMPLETE",
    cleaningStatus: "COMPLETE",
    accessStatus: "ACTIVE",
    maxGuests: 4,
    bookedGuestCount: 2,
  },
  conversation: [{ role: "guest", content: "What time is checkout?" }],
  expectation: {
    intents: ["CHECKOUT_TIME_INFO"],
    requiredBehaviors: ["answer from benchmark context"],
    forbiddenBehaviors: ["invent checkout time"],
  },
};

test("OpenAI benchmark adapter emits environment none and mock tools only", async () => {
  let captured: AgentsApiSessionRequest | undefined;
  const transport: AgentsApiTransport = {
    async createSession(request) {
      captured = request;
      return {
        scenarioId: scenario.id,
        model: "gpt-5.6-luna",
        responseText: "Checkout is at 11:00 AM.",
        toolCalls: [],
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
        latencyMs: 10,
        estimatedCostUsd: 0,
        expectationResults: {
          intentsSatisfied: [],
          requiredBehaviorsSatisfied: [],
          forbiddenBehaviorsObserved: [],
          criticalFailuresObserved: [],
        },
      };
    },
  };

  const adapter = new OpenAIAgentsBenchmarkAdapter("gpt-5.6-luna", transport);
  await adapter.evaluateScenario(scenario);

  assert.ok(captured);
  assert.deepEqual(captured.environment, { type: "none" });
  assert.equal(captured.metadata.benchmark, "true");
  assert.equal(captured.metadata.organization_id, "benchmark-org-adapter");
  assert.deepEqual(
    captured.agent.tools.map((tool) => tool.name),
    OPENAI_AGENTS_BENCHMARK_TOOLS.map((tool) => tool.name),
  );
});

test("OpenAI benchmark adapter blocks non-benchmark tenant context", async () => {
  const transport: AgentsApiTransport = {
    async createSession() {
      throw new Error("transport must not be called");
    },
  };
  const adapter = new OpenAIAgentsBenchmarkAdapter("gpt-5.6-luna", transport);

  await assert.rejects(
    adapter.evaluateScenario({
      ...scenario,
      context: { ...scenario.context, organizationId: "real-org" },
    }),
    /OPENAI_BENCHMARK_NON_BENCHMARK_ORG_BLOCKED/,
  );
});
