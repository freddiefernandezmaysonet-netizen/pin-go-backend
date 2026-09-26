import {
  PIN_AI_RUNTIME_TOOLS,
  isPinAIRuntimeToolEnabled,
  type PinAIRuntimeRequest,
  type PinAIRuntimeResponse,
  type PinAIRuntimeToolName,
} from "./contracts.js";
import type { PinAIConversationMemory } from "./conversation-memory.js";
import {
  buildPinAIOpenAIAgentConfig,
  type PinAIOpenAIActionProposalConfig,
  type PinAIOpenAIWebSearchConfig,
} from "./openai-agent-config.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";

export type OpenAIRuntimeTransportConfig = Readonly<{
  enabled: boolean;
  apiKey?: string;
  agentId?: string;
  resumeSessionId?: string;
  model: "gpt-5.6-luna";
  webSearch?: PinAIOpenAIWebSearchConfig;
  actionProposal?: PinAIOpenAIActionProposalConfig;
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

type RuntimeTurn = Readonly<{
  id: string;
  status: "queued" | "in_progress" | "waiting" | "completed" | "failed" | "cancelled";
  subagentId: string | null;
  error: unknown;
}>;

export type CompletedRuntimeTurnEvidence = Readonly<{
  sessionId: string;
  turnId: string;
  assistantMessageId: string;
  status: "completed";
}>;

type Collection = Readonly<{
  data: readonly Record<string, unknown>[];
  lastId?: string;
}>;

const MAX_COLLECTION_PAGES = 10;

export class OpenAIAgentsRuntimeTransport {
  private completedTurn: CompletedRuntimeTurnEvidence | null = null;

  constructor(
    private readonly config: OpenAIRuntimeTransportConfig,
    private readonly fetchImpl: RuntimeFetch,
  ) {}

  // Internal evidence only: the guest gateway does not expose provider IDs.
  getCompletedTurnEvidence(): CompletedRuntimeTurnEvidence | null {
    return this.completedTurn;
  }

  async run(
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
    tools: PinAIRuntimeToolExecutor,
  ): Promise<PinAIRuntimeResponse> {
    this.completedTurn = null;
    this.assertEnabled();
    const inputText = JSON.stringify({
      runtime: "pin-ai-v1",
      context: request.context,
      memory,
      conversation: request.conversation,
    });
    const recordedToolCalls: {
      name: PinAIRuntimeToolName;
      arguments: Readonly<Record<string, unknown>>;
    }[] = [];
    const handledCallIds = new Set<string>();
    const priorTurnIds = new Set<string>();
    const priorItemIds = new Set<string>();
    let turnCursor: string | undefined;
    let itemCursor: string | undefined;
    let requiresHumanReview = false;
    let session: RuntimeSessionSnapshot;

    if (this.config.resumeSessionId) {
      session = await this.retrieveSession(this.config.resumeSessionId);
      assertSessionNotFailed(session);
      if (session.status !== "idle") {
        throw new Error("PIN_AI_RUNTIME_AGENT_SESSION_BUSY");
      }
      // Capture the boundary BEFORE submitting input, including all pages.
      const priorTurns = await this.listCollection(session.id, "turns");
      for (const value of priorTurns.data) {
        const turn = parseTurn(value, session.id);
        priorTurnIds.add(turn.id);
        if (turn.subagentId === null && !isTerminalTurn(turn)) {
          throw new Error("PIN_AI_RUNTIME_AGENT_SESSION_BUSY");
        }
      }
      const priorItems = await this.listCollection(session.id, "items");
      for (const item of priorItems.data) {
        if (typeof item.id === "string") priorItemIds.add(item.id);
      }
      turnCursor = priorTurns.lastId;
      itemCursor = priorItems.lastId;
      await this.submitGuestMessage(session.id, inputText);
    } else {
      session = await this.createSession(request, inputText);
    }

    assertSessionNotFailed(session);
    const sessionId = session.id;
    let selectedTurnId: string | undefined;
    let inputVerified = false;
    const maxPolls = this.config.maxPolls ?? 30;

    for (let poll = 0; poll <= maxPolls; poll += 1) {
      const listed = await this.listCollection(sessionId, "turns", turnCursor);
      const roots = listed.data
        .map((value) => parseTurn(value, sessionId))
        .filter((turn) => turn.subagentId === null && !priorTurnIds.has(turn.id));
      if (roots.length > 1) {
        throw new Error("PIN_AI_RUNTIME_AGENT_TURN_AMBIGUOUS");
      }
      const turn = roots[0];
      if (turn) {
        if (selectedTurnId && selectedTurnId !== turn.id) {
          throw new Error("PIN_AI_RUNTIME_AGENT_TURN_CHANGED");
        }
        selectedTurnId = turn.id;
        assertTurnNotFailed(turn);
        let items: Collection | undefined;
        if (!inputVerified || turn.status === "completed") {
          items = await this.listCollection(sessionId, "items", itemCursor);
          inputVerified = hasCurrentInput(items.data, turn.id, inputText);
        }

        if (inputVerified && turn.status === "waiting") {
          session = await this.retrieveSession(sessionId);
          assertSessionNotFailed(session);
          if (session.status === "requires_action") {
            if (session.requiredActions.length === 0) {
              throw new Error("PIN_AI_RUNTIME_REQUIRES_ACTION_WITHOUT_ACTIONS");
            }
            // Validate the whole batch before executing any tool.
            if (session.requiredActions.some((action) => action.turnId !== turn.id)) {
              throw new Error("PIN_AI_RUNTIME_REQUIRED_ACTION_TURN_MISMATCH");
            }
            for (const action of session.requiredActions) {
              if (
                action.name ===
                  "prepare_reservation_modification" &&
                this.config.actionProposal
                  ?.enabled !== true
              ) {
                throw new Error(
                  "PIN_AI_RUNTIME_ACTION_PROPOSAL_TOOL_DISABLED",
                );
              }

              if (handledCallIds.has(action.callId)) {
                throw new Error(
                  `PIN_AI_RUNTIME_DUPLICATE_TOOL_CALL_ID:${sanitizeDiagnostic(action.callId)}`,
                );
              }
              handledCallIds.add(action.callId);
              recordedToolCalls.push({ name: action.name, arguments: action.arguments });
              if (action.name === "escalate_to_host") {
                requiresHumanReview = true;
                await this.submitToolResult(sessionId, action, {
                  shadow: true,
                  executed: false,
                  reason: "SHADOW_MODE_ESCALATION_NOT_EXECUTED",
                  guestFacingConstraint:
                    "Do not claim this request was sent or escalated. Say it would be escalated or requires host review.",
                });
                continue;
              }
              const output = await tools.execute(action.name, action.arguments, request, memory);
              if (toolResultRequiresHumanReview(output)) requiresHumanReview = true;
              await this.submitToolResult(sessionId, action, output);
            }
          }
        }

        if (inputVerified && turn.status === "completed" && items) {
          const message = extractCompletedAssistantMessage(
            items.data, turn.id, inputText, priorItemIds,
          );
          if (message) {
            const webSearchCallCount = items.data.filter((item) =>
              item.turn_id === turn.id && item.type === "web_search_call",
            ).length;
            this.completedTurn = Object.freeze({
              sessionId,
              turnId: turn.id,
              assistantMessageId: message.id,
              status: "completed",
            });
            return {
              responseText: message.text,
              openaiSessionId: sessionId,
              toolCalls: recordedToolCalls,
              webSearch: {
                enabled: this.config.webSearch?.enabled === true,
                used: webSearchCallCount > 0,
                callCount: webSearchCallCount,
              },
              escalationCreated: false,
              requiresHumanReview,
            };
          }
        }
      }
      // An idle session, absent turn, or not-yet-visible item is not success.
      if (poll < maxPolls) await delay(this.config.pollDelayMs ?? 500);
    }
    throw new Error("PIN_AI_RUNTIME_AGENT_TURN_POLL_LIMIT");
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new Error("PIN_AI_RUNTIME_OPENAI_DISABLED");
    if (!this.config.apiKey) throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
    if (this.config.model !== "gpt-5.6-luna") {
      throw new Error("PIN_AI_RUNTIME_MODEL_NOT_ALLOWED");
    }
    if (this.config.agentId !== undefined && !/^agent_[A-Za-z0-9]+$/.test(this.config.agentId)) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_INVALID");
    }
    if (this.config.resumeSessionId !== undefined &&
        !/^(?:sess|session)_[A-Za-z0-9_-]+$/.test(this.config.resumeSessionId)) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_SESSION_ID_INVALID");
    }
    if (this.config.maxPolls !== undefined &&
        (!Number.isInteger(this.config.maxPolls) || this.config.maxPolls < 0)) {
      throw new Error("PIN_AI_RUNTIME_POLL_LIMIT_INVALID");
    }
  }

  private async createSession(
    request: PinAIRuntimeRequest,
    inputText: string,
  ): Promise<RuntimeSessionSnapshot> {
    return parseSessionSnapshot(await this.requestJson("POST", "/v1/agents/sessions", JSON.stringify({
      environment: { type: "none" },
      ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
      agent: buildPinAIOpenAIAgentConfig(
        this.config.webSearch,
        this.config.actionProposal,
      ),
      input: inputText,
      metadata: {
        pin_ai_runtime: "v1",
        organization_id: request.context.organizationId,
        property_id: request.context.propertyId,
        reservation_id: request.context.reservationId,
      },
    })));
  }

  private async retrieveSession(sessionId: string): Promise<RuntimeSessionSnapshot> {
    const session = parseSessionSnapshot(await this.requestJson(
      "GET", `/v1/agents/sessions/${encodeURIComponent(sessionId)}`,
    ));
    if (session.id !== sessionId) {
      throw new Error("PIN_AI_RUNTIME_OPENAI_SESSION_ID_MISMATCH");
    }
    return session;
  }

  private async submitGuestMessage(sessionId: string, text: string): Promise<void> {
    await this.requestJson("POST", `/v1/agents/sessions/${encodeURIComponent(sessionId)}/events`,
      JSON.stringify({ events: [{
        type: "agent.session.input.message",
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
      }] }), true);
  }

  private async submitToolResult(
    sessionId: string,
    action: RuntimeRequiredAction,
    output: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.requestJson("POST", `/v1/agents/sessions/${encodeURIComponent(sessionId)}/events`,
      JSON.stringify({ events: [{
        type: "agent.session.input.tool_result",
        turn_id: action.turnId,
        call_id: action.callId,
        success: true,
        output: JSON.stringify(output),
      }] }), true);
  }

  private async listCollection(
    sessionId: string,
    collection: "items" | "turns",
    after?: string,
  ): Promise<Collection> {
    const data: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor = after;
    if (cursor) cursors.add(cursor);
    for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
      const payload = asRecord(await this.requestJson("GET",
        `/v1/agents/sessions/${encodeURIComponent(sessionId)}/${collection}?limit=100&order=asc` +
        (cursor ? `&after=${encodeURIComponent(cursor)}` : ""),
      ));
      if (!Array.isArray(payload.data) || typeof payload.has_more !== "boolean") {
        throw new Error("PIN_AI_RUNTIME_COLLECTION_INVALID");
      }
      const entries = payload.data.map(asRecord);
      for (const item of entries) {
        if (typeof item.id === "string") {
          if (ids.has(item.id)) throw new Error("PIN_AI_RUNTIME_COLLECTION_DUPLICATE_ID");
          ids.add(item.id);
        }
      }
      data.push(...entries);
      if (!payload.has_more) {
        const lastId = entries.at(-1)?.id;
        return { data, lastId: typeof lastId === "string" ? lastId : cursor };
      }
      const next = payload.last_id;
      if (entries.length === 0 || typeof next !== "string" || !next ||
          next !== entries.at(-1)?.id || cursors.has(next)) {
        throw new Error("PIN_AI_RUNTIME_COLLECTION_CURSOR_INVALID");
      }
      cursors.add(next);
      cursor = next;
    }
    throw new Error("PIN_AI_RUNTIME_COLLECTION_PAGE_LIMIT");
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    body?: string,
    allowEmpty = false,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.config.baseUrl ?? "https://api.openai.com"}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "OpenAI-Beta": "agents=v1",
      },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) throw new Error(`PIN_AI_RUNTIME_OPENAI_HTTP_${response.status}`);
    try {
      return await response.json();
    } catch {
      if (allowEmpty) return {};
      throw new Error("PIN_AI_RUNTIME_OPENAI_INVALID_RESPONSE");
    }
  }
}

const HUMAN_REVIEW_DECISIONS = new Set([
  "OPERATIONALLY_AVAILABLE_FOR_REVIEW", "PRICE_CALCULATED_FOR_REVIEW",
  "PRICE_REQUIRES_HUMAN_REVIEW", "DATE_CHANGE_AVAILABLE_FOR_REVIEW",
]);

function toolResultRequiresHumanReview(output: Readonly<Record<string, unknown>>): boolean {
  return output.requiresHumanReview === true || output.pricingReviewRequired === true ||
    (typeof output.decision === "string" && HUMAN_REVIEW_DECISIONS.has(output.decision));
}

function parseSessionSnapshot(payload: unknown): RuntimeSessionSnapshot {
  const root = asRecord(payload);
  const id = typeof root.id === "string" ? root.id : "";
  const status = root.status;
  if (!id) throw new Error("PIN_AI_RUNTIME_SESSION_ID_MISSING");
  if (status !== "idle" && status !== "in_progress" && status !== "requires_action" && status !== "failed") {
    throw new Error("PIN_AI_RUNTIME_SESSION_STATUS_INVALID");
  }
  return {
    id, status,
    requiredActions: Array.isArray(root.required_actions) ? root.required_actions.map(parseRequiredAction) : [],
    error: root.error,
  };
}

function parseTurn(payload: unknown, sessionId: string): RuntimeTurn {
  const value = asRecord(payload);
  if (typeof value.id !== "string" || !value.id || value.session_id !== sessionId ||
      !(value.subagent_id === null || typeof value.subagent_id === "string")) {
    throw new Error("PIN_AI_RUNTIME_AGENT_TURN_IDENTITY_INVALID");
  }
  const status = value.status;
  if (status !== "queued" && status !== "in_progress" && status !== "waiting" &&
      status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new Error("PIN_AI_RUNTIME_AGENT_TURN_STATUS_INVALID");
  }
  return { id: value.id, status, subagentId: value.subagent_id, error: value.error };
}

function isTerminalTurn(turn: RuntimeTurn): boolean {
  return turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled";
}

function assertSessionNotFailed(session: RuntimeSessionSnapshot): void {
  if (session.status === "failed") {
    throw new Error(`PIN_AI_RUNTIME_AGENT_SESSION_FAILED:${sanitizeDiagnostic(extractSessionError(session.error))}`);
  }
}

function assertTurnNotFailed(turn: RuntimeTurn): void {
  if (turn.status === "failed" || turn.status === "cancelled" || turn.error != null) {
    throw new Error(`PIN_AI_RUNTIME_AGENT_TURN_${turn.status === "cancelled" ? "CANCELLED" : "FAILED"}:${sanitizeDiagnostic(extractSessionError(turn.error))}`);
  }
}

function parseRequiredAction(value: unknown): RuntimeRequiredAction {
  const action = asRecord(value);
  if (action.type !== "function_call") throw new Error("PIN_AI_RUNTIME_UNSUPPORTED_REQUIRED_ACTION");
  const name = typeof action.name === "string" ? action.name : "";
  if (!PIN_AI_RUNTIME_TOOLS.some((tool) => tool.name === name) ||
      !isPinAIRuntimeToolEnabled(name as PinAIRuntimeToolName)) {
    throw new Error(`PIN_AI_RUNTIME_UNAPPROVED_TOOL:${sanitizeDiagnostic(name)}`);
  }
  const turnId = typeof action.turn_id === "string" ? action.turn_id : "";
  const callId = typeof action.call_id === "string" ? action.call_id : "";
  if (!turnId || !callId) throw new Error("PIN_AI_RUNTIME_REQUIRED_ACTION_ID_MISSING");
  if (!action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments)) {
    throw new Error(`PIN_AI_RUNTIME_TOOL_ARGUMENTS_INVALID:${sanitizeDiagnostic(callId)}`);
  }
  return { type: "function_call", turnId, callId, name: name as PinAIRuntimeToolName,
    arguments: action.arguments as Record<string, unknown> };
}

function hasCurrentInput(items: readonly Record<string, unknown>[], turnId: string, inputText: string): boolean {
  const inputs = items.filter((item) => item.type === "message" && item.role === "user" && item.turn_id === turnId);
  if (inputs.length === 0) return false;
  // One request owns one root turn; reject concurrent/steered or unrelated input.
  if (inputs.length !== 1 || inputs[0]?.status !== "completed" ||
      messageText(inputs[0], "input_text") !== inputText) {
    throw new Error("PIN_AI_RUNTIME_AGENT_TURN_INPUT_MISMATCH");
  }
  return true;
}

function extractCompletedAssistantMessage(
  items: readonly Record<string, unknown>[],
  turnId: string,
  inputText: string,
  priorItemIds: ReadonlySet<string>,
): Readonly<{ id: string; text: string }> | null {
  const inputIndex = items.findIndex((item) => item.type === "message" && item.role === "user" &&
    item.turn_id === turnId && messageText(item, "input_text") === inputText);
  const messages = items.slice(inputIndex + 1).filter((item) => item.type === "message" &&
    item.role === "assistant" && item.turn_id === turnId && item.phase === "final_answer");
  const latest = messages.at(-1);
  if (!latest || latest.status !== "completed") return null;
  if (typeof latest.id !== "string" || !latest.id || priorItemIds.has(latest.id)) {
    throw new Error("PIN_AI_RUNTIME_ASSISTANT_MESSAGE_ID_INVALID");
  }
  const text = messageText(latest, "output_text").trim();
  return text ? { id: latest.id, text } : null;
}

function messageText(item: Record<string, unknown>, type: "input_text" | "output_text"): string {
  const parts = Array.isArray(item.content) ? item.content.map(asRecord) : [];
  return parts.filter((part) => part.type === type && typeof part.text === "string")
    .map((part) => part.text as string).join("");
}

function extractSessionError(value: unknown): string {
  if (typeof value === "string") return value;
  const error = asRecord(value);
  return [["type", error.type], ["code", error.code], ["message", error.message]]
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, field]) => `${key}=${field}`).join(";") || "unknown_session_error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sanitizeDiagnostic(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return value.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}
