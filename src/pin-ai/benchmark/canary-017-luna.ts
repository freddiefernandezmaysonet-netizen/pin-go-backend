import { OpenAIAgentsBenchmarkAdapter } from "./openai-agents-benchmark-adapter.js";
import { OpenAIAgentsBenchmarkTransport } from "./openai-agents-benchmark-transport.js";
import { ModelEvaluationRunner } from "./model-evaluation-runner.js";
import { FixtureMockToolExecutor } from "./mock-tool-executor.js";
import { scenarios011To020 } from "./scenarios-011-020.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_BENCHMARK_ENABLED !== "true") throw new Error("PIN_AI_BENCHMARK_DISABLED");
  if (process.env.PIN_AI_BENCHMARK_SCENARIO !== "017") throw new Error("PIN_AI_BENCHMARK_CANARY_SCENARIO_MUST_BE_017");
  if (process.env.PIN_AI_BENCHMARK_MODEL !== "gpt-5.6-luna") throw new Error("PIN_AI_BENCHMARK_CANARY_MODEL_MUST_BE_LUNA");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("PIN_AI_BENCHMARK_OPENAI_API_KEY_MISSING");

  const scenario = scenarios011To020.find((item) => item.id === "017");
  if (!scenario) throw new Error("PIN_AI_BENCHMARK_SCENARIO_017_MISSING");

  let outboundCalls = 0;
  const guardedFetch = async (
    input: string,
    init: Readonly<{ method: "GET" | "POST"; headers: Readonly<Record<string, string>>; body?: string }>,
  ) => {
    outboundCalls += 1;
    if (outboundCalls > 40) throw new Error("PIN_AI_BENCHMARK_CANARY_NETWORK_CALL_LIMIT");

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

  // Fail closed: this statement alone should not trigger a late-checkout tool.
  const mockTools = new FixtureMockToolExecutor({});

  const runner = new ModelEvaluationRunner(adapter, mockTools);
  console.log("PIN_AI_BENCHMARK_CANARY_STARTED:017:gpt-5.6-luna");
  const result = await runner.runScenario(scenario);

  const usageAvailable =
    result.usage.inputTokens > 0 ||
    result.usage.cachedInputTokens > 0 ||
    result.usage.outputTokens > 0;

  console.log(
    JSON.stringify({
      benchmark: true,
      scenarioId: result.scenarioId,
      model: result.model,
      responseText: result.responseText,
      toolCalls: result.toolCalls.map((call) => call.name),
      usage: result.usage,
      usageStatus: usageAvailable ? "RECORDED" : "UNAVAILABLE",
      latencyMs: result.latencyMs,
      estimatedCostUsd: usageAvailable ? result.estimatedCostUsd : null,
      criticalFailuresObserved: result.expectationResults.criticalFailuresObserved,
      outboundCalls,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 1000));
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_BENCHMARK_CANARY_FAILED:${message}`);
  process.exitCode = 1;
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
