import type {
  AgentsApiSessionRequest,
  AgentsApiTransport,
} from "./openai-agents-benchmark-adapter.js";
import type { ScenarioEvaluationResult } from "./model-evaluation-runner.js";

export type BenchmarkTransportConfig = Readonly<{
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
}>;

export type BenchmarkFetch = (
  input: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
  }>,
) => Promise<Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>>;

export class OpenAIAgentsBenchmarkTransport implements AgentsApiTransport {
  constructor(
    private readonly config: BenchmarkTransportConfig,
    private readonly fetchImpl: BenchmarkFetch,
  ) {}

  async createSession(request: AgentsApiSessionRequest): Promise<ScenarioEvaluationResult> {
    if (!this.config.enabled) {
      throw new Error("PIN_AI_BENCHMARK_DISABLED");
    }

    if (!this.config.apiKey) {
      throw new Error("PIN_AI_BENCHMARK_OPENAI_API_KEY_MISSING");
    }

    if (request.metadata.benchmark !== "true") {
      throw new Error("PIN_AI_BENCHMARK_METADATA_REQUIRED");
    }

    if (!request.metadata.organization_id?.startsWith("benchmark-")) {
      throw new Error("PIN_AI_BENCHMARK_TENANT_SCOPE_BLOCKED");
    }

    const baseUrl = this.config.baseUrl ?? "https://api.openai.com";
    const response = await this.fetchImpl(`${baseUrl}/v1/agents/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`PIN_AI_BENCHMARK_OPENAI_HTTP_${response.status}`);
    }

    const payload = await response.json();
    return parseBenchmarkSessionResult(payload, request);
  }
}

function parseBenchmarkSessionResult(
  payload: unknown,
  request: AgentsApiSessionRequest,
): ScenarioEvaluationResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("PIN_AI_BENCHMARK_OPENAI_INVALID_RESPONSE");
  }

  const value = payload as Record<string, unknown>;
  const usage = asRecord(value.usage);
  const metadata = request.metadata;

  return {
    scenarioId: metadata.scenario_id,
    model: request.agent.model,
    responseText: typeof value.output_text === "string" ? value.output_text : "",
    toolCalls: [],
    usage: {
      inputTokens: asNonNegativeNumber(usage.input_tokens),
      cachedInputTokens: asNonNegativeNumber(usage.cached_input_tokens),
      outputTokens: asNonNegativeNumber(usage.output_tokens),
    },
    latencyMs: 0,
    estimatedCostUsd: 0,
    expectationResults: {
      intentsSatisfied: [],
      requiredBehaviorsSatisfied: [],
      forbiddenBehaviorsObserved: [],
      criticalFailuresObserved: [],
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
