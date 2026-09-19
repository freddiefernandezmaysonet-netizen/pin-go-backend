import {
  MOCK_TOOL_NAMES,
  type BenchmarkScenario,
  type MockToolName,
} from "./contracts.js";
import type {
  AgentsApiSessionRequest,
  AgentsApiTransport,
} from "./openai-agents-benchmark-adapter.js";
import type {
  MockToolExecutor,
  RecordedToolCall,
  ScenarioEvaluationResult,
} from "./model-evaluation-runner.js";

export type BenchmarkTransportConfig = Readonly<{
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  maxPolls?: number;
  pollDelayMs?: number;
}>;

export type BenchmarkFetch = (
  input: string,
  init: Readonly<{
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
    body?: string;
  }>,
) => Promise<Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>>;

type AgentSessionSnapshot = Readonly<{
  id: string;
  status: "idle" | "in_progress" | "requires_action" | "failed";
  requiredActions: readonly RequiredFunctionAction[];
  usage: Readonly<Record<string, unknown>>;
  error: unknown;
}>;

type RequiredFunctionAction = Readonly<{
  type: "function_call";
  turnId: string;
  callId: string;
  name: MockToolName;
  arguments: Readonly<Record<string, unknown>>;
}>;

export class OpenAIAgentsBenchmarkTransport implements AgentsApiTransport {
  constructor(
    private readonly config: BenchmarkTransportConfig,
    private readonly fetchImpl: BenchmarkFetch,
  ) {}

  async runSession(
    request: AgentsApiSessionRequest,
    scenario: BenchmarkScenario,
    tools: MockToolExecutor,
  ): Promise<ScenarioEvaluationResult> {
    this.assertEnabledAndScoped(request);

    const startedAt = Date.now();
    const recordedToolCalls: RecordedToolCall[] = [];
    let session = await this.createSession(request);
    let polls = 0;
    const maxPolls = this.config.maxPolls ?? 20;

    while (session.status !== "idle") {
      if (session.status === "failed") {
        throw new Error(
          `PIN_AI_BENCHMARK_AGENT_SESSION_FAILED:${sanitizeDiagnosticField(
            extractSessionError(session.error),
            "unknown_session_error",
          )}`,
        );
      }

      if (session.status === "requires_action") {
        if (session.requiredActions.length === 0) {
          throw new Error("PIN_AI_BENCHMARK_REQUIRES_ACTION_WITHOUT_ACTIONS");
        }

        for (const action of session.requiredActions) {
          const output = await tools.execute(action.name, action.arguments, scenario);
          recordedToolCalls.push({
            name: action.name,
            arguments: action.arguments,
          });
          await this.submitToolResult(session.id, action, output);
        }
      }

      polls += 1;
      if (polls > maxPolls) {
        throw new Error("PIN_AI_BENCHMARK_AGENT_SESSION_POLL_LIMIT");
      }

      await delay(this.config.pollDelayMs ?? 250);
      session = await this.retrieveSession(session.id);
    }

    const [items, turns] = await Promise.all([
      this.listSessionItems(session.id),
      this.listSessionTurns(session.id),
    ]);
    const responseText = extractAssistantText(items);
    const usage = preferRecordedUsage(
      parseUsage(session.usage),
      aggregateTurnUsage(turns),
    );

    return {
      scenarioId: request.metadata.scenario_id,
      model: request.agent.model,
      responseText,
      toolCalls: recordedToolCalls,
      usage,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: 0,
      expectationResults: {
        intentsSatisfied: [],
        requiredBehaviorsSatisfied: [],
        forbiddenBehaviorsObserved: [],
        criticalFailuresObserved: [],
      },
    };
  }

  private assertEnabledAndScoped(request: AgentsApiSessionRequest): void {
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
  }

  private async createSession(request: AgentsApiSessionRequest): Promise<AgentSessionSnapshot> {
    const payload = await this.requestJson(
      "POST",
      "/v1/agents/sessions",
      JSON.stringify(request),
    );
    return parseSessionSnapshot(payload);
  }

  private async retrieveSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const payload = await this.requestJson(
      "GET",
      `/v1/agents/sessions/${encodeURIComponent(sessionId)}`,
    );
    return parseSessionSnapshot(payload);
  }

  private async submitToolResult(
    sessionId: string,
    action: RequiredFunctionAction,
    output: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.requestJson(
      "POST",
      `/v1/agents/sessions/${encodeURIComponent(sessionId)}/events`,
      JSON.stringify({
        events: [
          {
            type: "agent.session.input.tool_result",
            turn_id: action.turnId,
            call_id: action.callId,
            success: true,
            output: JSON.stringify(output),
          },
        ],
      }),
      true,
    );
  }

  private async listSessionItems(sessionId: string): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/agents/sessions/${encodeURIComponent(sessionId)}/items?limit=100&order=asc`,
    );
  }

  private async listSessionTurns(sessionId: string): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/agents/sessions/${encodeURIComponent(sessionId)}/turns?limit=100&order=asc`,
    );
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    body?: string,
    allowEmpty = false,
  ): Promise<unknown> {
    const baseUrl = this.config.baseUrl ?? "https://api.openai.com";
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "OpenAI-Beta": "agents=v1",
      },
      ...(body === undefined ? {} : { body }),
    });

    if (!response.ok) {
      const errorPayload = await safeJson(response);
      const diagnostic = sanitizeOpenAIError(errorPayload);
      throw new Error(
        `PIN_AI_BENCHMARK_OPENAI_HTTP_${response.status}:${diagnostic.type}:${diagnostic.code}:${diagnostic.message}`,
      );
    }

    try {
      return await response.json();
    } catch {
      if (allowEmpty) return {};
      throw new Error("PIN_AI_BENCHMARK_OPENAI_INVALID_RESPONSE");
    }
  }
}

function parseSessionSnapshot(payload: unknown): AgentSessionSnapshot {
  const value = asRecord(payload);
  const id = typeof value.id === "string" ? value.id : "";
  const status = value.status;

  if (!id) {
    throw new Error("PIN_AI_BENCHMARK_OPENAI_SESSION_ID_MISSING");
  }

  if (
    status !== "idle" &&
    status !== "in_progress" &&
    status !== "requires_action" &&
    status !== "failed"
  ) {
    throw new Error("PIN_AI_BENCHMARK_OPENAI_SESSION_STATUS_INVALID");
  }

  const requiredActions = Array.isArray(value.required_actions)
    ? value.required_actions.map(parseRequiredAction)
    : [];

  return {
    id,
    status,
    requiredActions,
    usage: asRecord(value.usage),
    error: value.error,
  };
}

function parseRequiredAction(value: unknown): RequiredFunctionAction {
  const action = asRecord(value);
  if (action.type !== "function_call") {
    throw new Error("PIN_AI_BENCHMARK_UNSUPPORTED_REQUIRED_ACTION");
  }

  const name = typeof action.name === "string" ? action.name : "";
  if (!MOCK_TOOL_NAMES.includes(name as MockToolName)) {
    throw new Error(`PIN_AI_BENCHMARK_UNAPPROVED_TOOL:${sanitizeDiagnosticField(name, "unknown")}`);
  }

  const turnId = typeof action.turn_id === "string" ? action.turn_id : "";
  const callId = typeof action.call_id === "string" ? action.call_id : "";
  if (!turnId || !callId) {
    throw new Error("PIN_AI_BENCHMARK_REQUIRED_ACTION_ID_MISSING");
  }

  return {
    type: "function_call",
    turnId,
    callId,
    name: name as MockToolName,
    arguments: asRecord(action.arguments),
  };
}

function parseUsage(usage: Readonly<Record<string, unknown>>) {
  const details = asRecord(usage.input_tokens_details);
  return {
    inputTokens: asNonNegativeNumber(usage.input_tokens),
    cachedInputTokens: asNonNegativeNumber(details.cached_tokens),
    outputTokens: asNonNegativeNumber(usage.output_tokens),
  };
}

function aggregateTurnUsage(payload: unknown) {
  const root = asRecord(payload);
  const data = Array.isArray(root.data) ? root.data : [];
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const turnValue of data) {
    const turn = asRecord(turnValue);
    const usage = parseUsage(asRecord(turn.usage));
    inputTokens += usage.inputTokens;
    cachedInputTokens += usage.cachedInputTokens;
    outputTokens += usage.outputTokens;
  }

  return { inputTokens, cachedInputTokens, outputTokens };
}

function preferRecordedUsage(
  sessionUsage: ReturnType<typeof parseUsage>,
  turnUsage: ReturnType<typeof parseUsage>,
) {
  const sessionTotal =
    sessionUsage.inputTokens + sessionUsage.cachedInputTokens + sessionUsage.outputTokens;
  const turnTotal = turnUsage.inputTokens + turnUsage.cachedInputTokens + turnUsage.outputTokens;
  return turnTotal > sessionTotal ? turnUsage : sessionUsage;
}

function aggregateTurnUsage(payload: unknown) {
  const root = asRecord(payload);
  const data = Array.isArray(root.data) ? root.data : [];
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const turnValue of data) {
    const turn = asRecord(turnValue);
    const usage = parseUsage(asRecord(turn.usage));
    inputTokens += usage.inputTokens;
    cachedInputTokens += usage.cachedInputTokens;
    outputTokens += usage.outputTokens;
  }

  return { inputTokens, cachedInputTokens, outputTokens };
}

function preferRecordedUsage(
  sessionUsage: ReturnType<typeof parseUsage>,
  turnUsage: ReturnType<typeof parseUsage>,
) {
  const sessionTotal =
    sessionUsage.inputTokens + sessionUsage.cachedInputTokens + sessionUsage.outputTokens;
  const turnTotal = turnUsage.inputTokens + turnUsage.cachedInputTokens + turnUsage.outputTokens;
  return turnTotal > sessionTotal ? turnUsage : sessionUsage;
}

function extractAssistantText(payload: unknown): string {
  const root = asRecord(payload);
  const data = Array.isArray(root.data) ? root.data : [];
  const chunks: string[] = [];

  for (const itemValue of data) {
    const item = asRecord(itemValue);
    if (item.type !== "message" || item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const partValue of content) {
      const part = asRecord(partValue);
      if (part.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

type SanitizedOpenAIError = Readonly<{
  type: string;
  code: string;
  message: string;
}>;

async function safeJson(response: Readonly<{ json(): Promise<unknown> }>): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function sanitizeOpenAIError(payload: unknown): SanitizedOpenAIError {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  return {
    type: sanitizeDiagnosticField(error.type, "unknown_type"),
    code: sanitizeDiagnosticField(error.code, "unknown_code"),
    message: sanitizeDiagnosticField(error.message, "no_message"),
  };
}

function extractSessionError(value: unknown): string {
  if (typeof value === "string") return value;
  const error = asRecord(value);
  if (typeof error.message === "string") return error.message;
  return "unknown_session_error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeDiagnosticField(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
