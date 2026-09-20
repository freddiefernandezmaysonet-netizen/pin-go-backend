import {
  PIN_AI_RUNTIME_TOOLS,
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
  type PinAIRuntimeResponse,
  type PinAIRuntimeToolName,
} from "./contracts.js";
import type { PinAIConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";

export type OpenAIRuntimeTransportConfig = Readonly<{
  enabled: boolean;
  apiKey?: string;
  model: "gpt-5.6-luna";
  baseUrl?: string;
  maxPolls?: number;
  pollDelayMs?: number;
}>;

export type RuntimeFetch = (
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

type RuntimeRequiredAction = Readonly<{
  type: "function_call";
  turnId: string;
  callId: string;
  name: PinAIRuntimeToolName;
  arguments: Readonly<Record<string, unknown>>;
}>;

type RuntimeSessionSnapshot = Readonly<{
  id: string;
  status: "idle" | "in_progress" | "requires_action" | "failed";
  requiredActions: readonly RuntimeRequiredAction[];
  error: unknown;
}>;

export class OpenAIAgentsRuntimeTransport {
  constructor(
    private readonly config: OpenAIRuntimeTransportConfig,
    private readonly fetchImpl: RuntimeFetch,
  ) {}

  async run(
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
    tools: PinAIRuntimeToolExecutor,
  ): Promise<PinAIRuntimeResponse> {
    this.assertEnabled();

    const recordedToolCalls: {
      name: PinAIRuntimeToolName;
      arguments: Readonly<Record<string, unknown>>;
    }[] = [];
    const handledCallIds = new Set<string>();

    let escalationCreated = false;
    let requiresHumanReview = false;

    let session = await this.createSession(request, memory);
    let polls = 0;
    const maxPolls = this.config.maxPolls ?? 30;

    while (session.status !== "idle") {
      if (session.status === "failed") {
        throw new Error(
          `PIN_AI_RUNTIME_AGENT_SESSION_FAILED:${sanitizeDiagnostic(
            extractSessionError(session.error),
          )}`,
        );
      }

      if (session.status === "requires_action") {
        if (session.requiredActions.length === 0) {
          throw new Error("PIN_AI_RUNTIME_REQUIRES_ACTION_WITHOUT_ACTIONS");
        }

        for (const action of session.requiredActions) {
          if (handledCallIds.has(action.callId)) {
            throw new Error(
              `PIN_AI_RUNTIME_DUPLICATE_TOOL_CALL_ID:${sanitizeDiagnostic(action.callId)}`,
            );
          }
          handledCallIds.add(action.callId);

          recordedToolCalls.push({
            name: action.name,
            arguments: action.arguments,
          });

          if (action.name === "escalate_to_host") {
            // Runtime V1 shadow safety: record the proposal but do not execute escalation.
            requiresHumanReview = true;
            await this.submitShadowToolResult(session.id, action, {
              shadow: true,
              executed: false,
              reason: "SHADOW_MODE_ESCALATION_NOT_EXECUTED",
              guestFacingConstraint:
                "Do not claim this request was sent or escalated. Say it would be escalated or requires host review.",
            });
            continue;
          }

          const output = await tools.execute(
            action.name,
            action.arguments,
            request,
            memory,
          );

          await this.submitToolResult(session.id, action, output);
        }
      }

      polls += 1;
      if (polls > maxPolls) {
        throw new Error("PIN_AI_RUNTIME_AGENT_SESSION_POLL_LIMIT");
      }

      await delay(this.config.pollDelayMs ?? 500);
      session = await this.retrieveSession(session.id);
    }

    const items = await this.listSessionItems(session.id);
    const responseText = extractAssistantText(items);

    return {
      responseText,
      toolCalls: recordedToolCalls,
      escalationCreated,
      requiresHumanReview,
    };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_DISABLED");
    }
    if (!this.config.apiKey) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
    }
    if (this.config.model !== "gpt-5.6-luna") {
      throw new Error("PIN_AI_RUNTIME_MODEL_NOT_ALLOWED");
    }
  }

  private async createSession(
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
  ): Promise<RuntimeSessionSnapshot> {
    const payload = {
      environment: { type: "none" },
      agent: {
        model: this.config.model,
        instructions: [
          "You are Pin AI Guest Services.",
          "Use the supplied stay context, conversation memory, and runtime tools.",
          "Do not invent property, reservation, access, payment, or policy facts.",
          "Do not perform irreversible actions directly.",
          "When escalation is needed, request escalate_to_host; Runtime V1 shadow mode will record it without executing it.",
          "In shadow mode, never tell the guest that an escalation, host request, refund, cancellation, payment, access change, or reservation change was sent, completed, approved, or executed unless the tool result explicitly says executed=true.",
          "If escalate_to_host returns executed=false, describe it only as something that would be escalated or requires host review.",
          "Keep resolved issues resolved and do not repeat exhausted troubleshooting.",
          "Reply naturally in the guest's current language.",
        ].join(" "),
        tools: PIN_AI_RUNTIME_TOOLS.filter((tool) =>
          isPinAIRuntimeToolEnabled(tool.name),
        ).map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters:
            tool.parameters ?? {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
        })),
      },
      input: JSON.stringify({
        runtime: "pin-ai-v1",
        context: request.context,
        memory,
        conversation: request.conversation,
      }),
      metadata: {
        pin_ai_runtime: "v1",
        organization_id: request.context.organizationId,
        property_id: request.context.propertyId,
        reservation_id: request.context.reservationId,
      },
    };

    return parseSessionSnapshot(
      await this.requestJson(
        "POST",
        "/v1/agents/sessions",
        JSON.stringify(payload),
      ),
    );
  }

  private async retrieveSession(sessionId: string): Promise<RuntimeSessionSnapshot> {
    return parseSessionSnapshot(
      await this.requestJson(
        "GET",
        `/v1/agents/sessions/${encodeURIComponent(sessionId)}`,
      ),
    );
  }

  private async submitToolResult(
    sessionId: string,
    action: RuntimeRequiredAction,
    output: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.submitShadowToolResult(sessionId, action, output);
  }

  private async submitShadowToolResult(
    sessionId: string,
    action: RuntimeRequiredAction,
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
      throw new Error(`PIN_AI_RUNTIME_OPENAI_HTTP_${response.status}`);
    }

    try {
      return await response.json();
    } catch {
      if (allowEmpty) return {};
      throw new Error("PIN_AI_RUNTIME_OPENAI_INVALID_RESPONSE");
    }
  }
}

function parseSessionSnapshot(payload: unknown): RuntimeSessionSnapshot {
  const root = asRecord(payload);
  const id = typeof root.id === "string" ? root.id : "";
  const status = root.status;

  if (!id) throw new Error("PIN_AI_RUNTIME_SESSION_ID_MISSING");
  if (
    status !== "idle" &&
    status !== "in_progress" &&
    status !== "requires_action" &&
    status !== "failed"
  ) {
    throw new Error("PIN_AI_RUNTIME_SESSION_STATUS_INVALID");
  }

  const requiredActions = Array.isArray(root.required_actions)
    ? root.required_actions.map(parseRequiredAction)
    : [];

  return {
    id,
    status,
    requiredActions,
    error: root.error,
  };
}

function parseRequiredAction(value: unknown): RuntimeRequiredAction {
  const action = asRecord(value);
  if (action.type !== "function_call") {
    throw new Error("PIN_AI_RUNTIME_UNSUPPORTED_REQUIRED_ACTION");
  }

  const name = typeof action.name === "string" ? action.name : "";
  const allowed =
    PIN_AI_RUNTIME_TOOLS.some((tool) => tool.name === name) &&
    isPinAIRuntimeToolEnabled(name as PinAIRuntimeToolName);
  if (!allowed) {
    throw new Error(`PIN_AI_RUNTIME_UNAPPROVED_TOOL:${sanitizeDiagnostic(name)}`);
  }

  const turnId = typeof action.turn_id === "string" ? action.turn_id : "";
  const callId = typeof action.call_id === "string" ? action.call_id : "";
  if (!turnId || !callId) {
    throw new Error("PIN_AI_RUNTIME_REQUIRED_ACTION_ID_MISSING");
  }

  if (
    !action.arguments ||
    typeof action.arguments !== "object" ||
    Array.isArray(action.arguments)
  ) {
    throw new Error(
      `PIN_AI_RUNTIME_TOOL_ARGUMENTS_INVALID:${sanitizeDiagnostic(callId)}`,
    );
  }

  return {
    type: "function_call",
    turnId,
    callId,
    name: name as PinAIRuntimeToolName,
    arguments: action.arguments as Record<string, unknown>,
  };
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

function extractSessionError(value: unknown): string {
  if (typeof value === "string") return value;
  const error = asRecord(value);
  return typeof error.message === "string"
    ? error.message
    : "unknown_session_error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeDiagnostic(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
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
