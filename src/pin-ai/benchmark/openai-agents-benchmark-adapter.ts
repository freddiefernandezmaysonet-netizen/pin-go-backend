import type { BenchmarkScenario, MockToolName } from "./contracts.js";
import type {
  ModelCandidate,
  ModelEvaluationAdapter,
  MockToolExecutor,
  ScenarioEvaluationResult,
} from "./model-evaluation-runner.js";

export type AgentsApiFunctionTool = Readonly<{
  type: "function";
  name: MockToolName;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type AgentsApiSessionRequest = Readonly<{
  environment: Readonly<{ type: "none" }>;
  agent: Readonly<{
    model: ModelCandidate;
    instructions: string;
    tools: readonly AgentsApiFunctionTool[];
  }>;
  input: string;
  metadata: Readonly<Record<string, string>>;
}>;

export interface AgentsApiTransport {
  runSession(
    request: AgentsApiSessionRequest,
    scenario: BenchmarkScenario,
    tools: MockToolExecutor,
  ): Promise<ScenarioEvaluationResult>;
}

const MOCK_FUNCTION_TOOLS: readonly AgentsApiFunctionTool[] = [
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
].map((name) => ({
  type: "function" as const,
  name: name as MockToolName,
  description: `Benchmark-only mock function: ${name}`,
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}));

function serializeScenario(scenario: BenchmarkScenario): string {
  return JSON.stringify({
    benchmark: true,
    scenarioId: scenario.id,
    stayContext: scenario.context,
    conversation: scenario.conversation,
    expectation: scenario.expectation,
  });
}

export class OpenAIAgentsBenchmarkAdapter implements ModelEvaluationAdapter {
  constructor(
    readonly model: ModelCandidate,
    private readonly transport: AgentsApiTransport,
  ) {}

  async evaluateScenario(
    scenario: BenchmarkScenario,
    tools: MockToolExecutor,
  ): Promise<ScenarioEvaluationResult> {
    if (!scenario.context.organizationId.startsWith("benchmark-")) {
      throw new Error("OPENAI_BENCHMARK_NON_BENCHMARK_ORG_BLOCKED");
    }

    if (!scenario.context.propertyId.startsWith("benchmark-")) {
      throw new Error("OPENAI_BENCHMARK_NON_BENCHMARK_PROPERTY_BLOCKED");
    }

    const request: AgentsApiSessionRequest = {
      environment: { type: "none" },
      agent: {
        model: this.model,
        instructions: [
          "You are Pin AI Guest Services running an isolated benchmark.",
          "Use only supplied StayContext and benchmark function tools.",
          "Never claim a tool action succeeded unless its benchmark result confirms it.",
          "Never request or use production systems, external credentials, or non-benchmark tenant data.",
        ].join(" "),
        tools: MOCK_FUNCTION_TOOLS,
      },
      input: serializeScenario(scenario),
      metadata: {
        benchmark: "true",
        scenario_id: scenario.id,
        organization_id: scenario.context.organizationId,
      },
    };

    return this.transport.runSession(request, scenario, tools);
  }
}

export const OPENAI_AGENTS_BENCHMARK_TOOLS = MOCK_FUNCTION_TOOLS;
