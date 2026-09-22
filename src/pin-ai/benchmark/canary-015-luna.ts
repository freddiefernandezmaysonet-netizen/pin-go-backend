import { OpenAIAgentsBenchmarkAdapter } from "./openai-agents-benchmark-adapter.js";
import { OpenAIAgentsBenchmarkTransport } from "./openai-agents-benchmark-transport.js";
import { ModelEvaluationRunner } from "./model-evaluation-runner.js";
import { PropertyKnowledgeBenchmarkToolExecutor } from "./property-knowledge-benchmark-tool-executor.js";
import { scenarios011To020 } from "./scenarios-011-020.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_BENCHMARK_ENABLED !== "true") throw new Error("PIN_AI_BENCHMARK_DISABLED");
  if (process.env.PIN_AI_BENCHMARK_SCENARIO !== "015") throw new Error("PIN_AI_BENCHMARK_CANARY_SCENARIO_MUST_BE_015");
  if (process.env.PIN_AI_BENCHMARK_MODEL !== "gpt-5.6-luna") throw new Error("PIN_AI_BENCHMARK_CANARY_MODEL_MUST_BE_LUNA");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("PIN_AI_BENCHMARK_OPENAI_API_KEY_MISSING");

  const scenario = scenarios011To020.find((item) => item.id === "015");
  if (!scenario) throw new Error("PIN_AI_BENCHMARK_SCENARIO_015_MISSING");

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

  const mockTools = new PropertyKnowledgeBenchmarkToolExecutor(
    {
      id: scenario.context.propertyId,
      organizationId: scenario.context.organizationId,
      name: "Benchmark Property",
      publicTitle: "Benchmark Stay",
      publicDescription: "Guest-facing benchmark property. AC guidance: confirm the unit has power and the display is on; set mode to COOL at 72°F; allow up to 3 minutes for the compressor to start; if it still does not cool, stop troubleshooting and escalate for maintenance.",
      publicDescriptionEs: "Propiedad benchmark para huéspedes.",
      maxGuests: scenario.context.maxGuests,
      timezone: "America/Puerto_Rico",
      checkInTime: "16:00",
      checkOutTime: "11:00",
      guestAccessMode: "PASSCODE_ONLY",
      amenities: [
        {
          name: "Air conditioning",
          description: "Mini-split AC in the bedroom and living room.",
          chargeMode: "INCLUDED",
        },
      ],
      locks: [],
      propertyDevices: [
        {
          name: "Living Room AC",
          type: "AIR_CONDITIONER",
          provider: "TUYA",
        },
      ],
      guestAgreements: [],
      cancellationPolicies: []
    },
    {},
  );

  const runner = new ModelEvaluationRunner(adapter, mockTools);
  console.log("PIN_AI_BENCHMARK_CANARY_STARTED:015:gpt-5.6-luna");
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
