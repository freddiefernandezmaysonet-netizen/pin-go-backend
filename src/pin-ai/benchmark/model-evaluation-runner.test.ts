import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkScenario } from "./contracts.js";
import {
  ModelEvaluationRunner,
  type ModelEvaluationAdapter,
  type ScenarioEvaluationResult,
} from "./model-evaluation-runner.js";
import { FixtureMockToolExecutor } from "./mock-tool-executor.js";

const scenario: BenchmarkScenario = {
  id: "runner-test-001",
  title: "Runner isolation contract",
  category: "GROUNDING",
  context: {
    organizationId: "benchmark-org-runner",
    propertyId: "benchmark-property-runner",
    reservationId: "benchmark-reservation-runner",
    guestId: "benchmark-guest-runner",
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

const passingResult: ScenarioEvaluationResult = {
  scenarioId: scenario.id,
  model: "gpt-5.6-luna",
  responseText: "Checkout is at 11:00 AM.",
  toolCalls: [],
  usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
  latencyMs: 25,
  estimatedCostUsd: 0.0001,
  expectationResults: {
    intentsSatisfied: ["CHECKOUT_TIME_INFO"],
    requiredBehaviorsSatisfied: ["answer from benchmark context"],
    forbiddenBehaviorsObserved: [],
    criticalFailuresObserved: [],
  },
};

test("model evaluation runner accepts a matching isolated result", async () => {
  const adapter: ModelEvaluationAdapter = {
    model: "gpt-5.6-luna",
    async evaluateScenario() {
      return passingResult;
    },
  };
  const tools = new FixtureMockToolExecutor({
    get_reservation_context: { checkoutLocal: scenario.context.checkOutLocal },
  });
  const runner = new ModelEvaluationRunner(adapter, tools);

  assert.deepEqual(await runner.runScenario(scenario), passingResult);
});

test("fixture executor fails closed when a mock tool fixture is missing", async () => {
  const tools = new FixtureMockToolExecutor({});

  await assert.rejects(
    tools.execute("get_access_status", {}, scenario),
    /MOCK_TOOL_FIXTURE_MISSING:runner-test-001:get_access_status/,
  );
});

test("model evaluation runner rejects mismatched scenario identity", async () => {
  const adapter: ModelEvaluationAdapter = {
    model: "gpt-5.6-luna",
    async evaluateScenario() {
      return { ...passingResult, scenarioId: "wrong-scenario" };
    },
  };
  const runner = new ModelEvaluationRunner(adapter, new FixtureMockToolExecutor({}));

  await assert.rejects(
    runner.runScenario(scenario),
    /MODEL_EVALUATION_SCENARIO_MISMATCH/,
  );
});
