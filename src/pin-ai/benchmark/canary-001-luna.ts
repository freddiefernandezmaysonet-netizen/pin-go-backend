import { OpenAIAgentsBenchmarkAdapter } from "./openai-agents-benchmark-adapter.js";
import { OpenAIAgentsBenchmarkTransport } from "./openai-agents-benchmark-transport.js";
import { ModelEvaluationRunner } from "./model-evaluation-runner.js";
import { FixtureMockToolExecutor } from "./mock-tool-executor.js";
import { scenarios001To010 } from "./scenarios-001-010.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_BENCHMARK_ENABLED !== "true") {
    throw new Error("PIN_AI_BENCHMARK_DISABLED");
  }

  if (process.env.PIN_AI_BENCHMARK_SCENARIO !== "001") {
    throw new Error("PIN_AI_BENCHMARK_CANARY_SCENARIO_MUST_BE_001");
  }

  if (process.env.PIN_AI_BENCHMARK_MODEL !== "gpt-5.6-luna") {
    throw new Error("PIN_AI_BENCHMARK_CANARY_MODEL_MUST_BE_LUNA");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("PIN_AI_BENCHMARK_OPENAI_API_KEY_MISSING");
  }

  const scenario = scenarios001To010.find((item) => item.id === "001");
  if (!scenario) {
    throw new Error("PIN_AI_BENCHMARK_SCENARIO_001_MISSING");
  }

  let outboundCalls = 0;
  const guardedFetch = async (
    input: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ) => {
    outboundCalls += 1;
    if (outboundCalls > 40) {
      throw new Error("PIN_AI_BENCHMARK_CANARY_NETWORK_CALL_LIMIT");
    }

    const response = await fetch(input, init);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  };

  const transport = new OpenAIAgentsBenchmarkTransport(
    { enabled: true, apiKey, maxPolls: 30, pollDelayMs: 500 },
    guardedFetch,
  );
  const adapter = new OpenAIAgentsBenchmarkAdapter("gpt-5.6-luna", transport);
  const mockTools = new FixtureMockToolExecutor({
    get_reservation_context: {
      reservationStatus: scenario.context.reservationStatus,
      checkInLocal: scenario.context.checkInLocal,
      checkOutLocal: scenario.context.checkOutLocal,
    },
    get_access_status: {
      accessStatus: scenario.context.accessStatus,
      accessStartsAtLocal: scenario.context.accessStartsAtLocal,
    },
    get_cleaning_status: {
      cleaningStatus: scenario.context.cleaningStatus,
    },
  });
  const runner = new ModelEvaluationRunner(adapter, mockTools);
  const result = await runner.runScenario(scenario);

  process.stdout.write(
    JSON.stringify({
      benchmark: true,
      scenarioId: result.scenarioId,
      model: result.model,
      responseText: result.responseText,
      toolCalls: result.toolCalls.map((call) => call.name),
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
      criticalFailuresObserved: result.expectationResults.criticalFailuresObserved,
      outboundCalls,
    }) + "\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  process.stderr.write(`PIN_AI_BENCHMARK_CANARY_FAILED:${message}\n`);
  process.exitCode = 1;
});
