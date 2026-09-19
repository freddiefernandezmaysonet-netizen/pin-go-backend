import type { BenchmarkScenario, MockToolName } from "./contracts.js";

export type ModelCandidate = "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-6-astra";

export type ModelUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}>;

export type RecordedToolCall = Readonly<{
  name: MockToolName;
  arguments: Readonly<Record<string, unknown>>;
}>;

export type ScenarioEvaluationResult = Readonly<{
  scenarioId: string;
  model: ModelCandidate;
  responseText: string;
  toolCalls: readonly RecordedToolCall[];
  usage: ModelUsage;
  latencyMs: number;
  estimatedCostUsd: number;
  expectationResults: Readonly<{
    intentsSatisfied: readonly string[];
    requiredBehaviorsSatisfied: readonly string[];
    forbiddenBehaviorsObserved: readonly string[];
    criticalFailuresObserved: readonly string[];
  }>;
}>;

export interface MockToolExecutor {
  execute(
    tool: MockToolName,
    args: Readonly<Record<string, unknown>>,
    scenario: BenchmarkScenario,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface ModelEvaluationAdapter {
  readonly model: ModelCandidate;
  evaluateScenario(
    scenario: BenchmarkScenario,
    tools: MockToolExecutor,
  ): Promise<ScenarioEvaluationResult>;
}

export class ModelEvaluationRunner {
  constructor(
    private readonly adapter: ModelEvaluationAdapter,
    private readonly tools: MockToolExecutor,
  ) {}

  async runScenario(scenario: BenchmarkScenario): Promise<ScenarioEvaluationResult> {
    const result = await this.adapter.evaluateScenario(scenario, this.tools);

    if (result.scenarioId !== scenario.id) {
      throw new Error(`MODEL_EVALUATION_SCENARIO_MISMATCH:${scenario.id}:${result.scenarioId}`);
    }

    if (result.model !== this.adapter.model) {
      throw new Error(`MODEL_EVALUATION_MODEL_MISMATCH:${this.adapter.model}:${result.model}`);
    }

    if (result.latencyMs < 0 || result.estimatedCostUsd < 0) {
      throw new Error("MODEL_EVALUATION_INVALID_METRICS");
    }

    return result;
  }
}
