import type { RuntimeFetch } from "./openai-agents-runtime-transport.js";

export type TestItem = Record<string, unknown>;
export type TestAction = Readonly<{ name: string; arguments?: unknown; turn_id?: string; call_id?: string }>;

export function jsonResponse(payload: unknown, status = 200) {
  const snapshot = structuredClone(payload);
  return { ok: status >= 200 && status < 300, status, async json() { return structuredClone(snapshot); } };
}

export function page(data: readonly TestItem[]) {
  return { object: "list", data, first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null, has_more: false };
}

// Entirely in-memory protocol fixture. It never calls global fetch or a database.
export function createTurnFixture(options: Readonly<{
  sessionId?: string;
  actions?: (turnNumber: number) => readonly TestAction[];
  answer?: (turnNumber: number, inputs: readonly string[]) => string;
}> = {}) {
  const sessionId = options.sessionId ?? "sess_fixture";
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const inputs: string[] = [];
  const turns: TestItem[] = [];
  const items: TestItem[] = [];
  const toolResults: TestItem[] = [];
  let pending: TestItem[] = [];
  let createCount = 0;
  let createPayload: TestItem = {};

  function finish() {
    const turn = turns.at(-1)!;
    turn.status = "completed";
    turn.completed_at = 2;
    if (!items.some((item) => item.id === `msg_assistant_${inputs.length}`)) {
      items.push({ id: `msg_assistant_${inputs.length}`, type: "message", role: "assistant",
        turn_id: turn.id, status: "completed", phase: "final_answer",
        content: [{ type: "output_text", text: options.answer?.(inputs.length, inputs) ?? "Checked." }] });
    }
  }

  function addInput(text: string) {
    inputs.push(text);
    const id = `turn_${inputs.length}`;
    pending = (options.actions?.(inputs.length) ?? []).map((action, index) => ({
      type: "function_call", name: action.name,
      arguments: action.arguments === undefined ? {} : action.arguments,
      turn_id: action.turn_id ?? id, call_id: action.call_id ?? `call_${inputs.length}_${index}`,
    }));
    turns.push({ id, object: "agent.session.turn", session_id: sessionId,
      agent_id: "agent_saved123", subagent_id: null, created_at: 1,
      started_at: 1, completed_at: null, error: null, status: pending.length ? "waiting" : "completed" });
    items.push({ id: `msg_user_${inputs.length}`, type: "message", role: "user",
      turn_id: id, status: "completed", phase: null, content: [{ type: "input_text", text }] });
    if (pending.length === 0) finish();
  }

  function collection(data: TestItem[], url: URL) {
    const cursor = url.searchParams.get("after");
    const start = cursor ? data.findIndex((item) => item.id === cursor) + 1 : 0;
    if (cursor && start === 0) throw new Error("UNKNOWN_FIXTURE_CURSOR");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const selected = data.slice(start, start + limit);
    return { ...page(selected), has_more: start + selected.length < data.length };
  }

  const fetchImpl: RuntimeFetch = async (urlValue, init) => {
    calls.push({ url: urlValue, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const url = new URL(urlValue);
    if (init.method === "POST" && url.pathname === "/v1/agents/sessions") {
      createCount += 1;
      createPayload = JSON.parse(init.body ?? "{}");
      addInput(createPayload.input as string);
      return jsonResponse({ id: sessionId, status: pending.length ? "requires_action" : "idle", required_actions: pending });
    }
    if (!url.pathname.startsWith(`/v1/agents/sessions/${sessionId}`)) {
      throw new Error("UNEXPECTED_FIXTURE_SESSION");
    }
    if (init.method === "POST" && url.pathname.endsWith("/events")) {
      const body = JSON.parse(init.body ?? "{}");
      for (const event of body.events) {
        if (event.type === "agent.session.input.message") {
          addInput(event.input[0].content[0].text);
        } else if (event.type === "agent.session.input.tool_result") {
          toolResults.push(event);
          pending = pending.filter((action) => action.call_id !== event.call_id);
          if (pending.length === 0) finish();
        } else {
          throw new Error("UNEXPECTED_FIXTURE_EVENT");
        }
      }
      return jsonResponse({});
    }
    if (init.method === "GET" && url.pathname.endsWith("/turns")) return jsonResponse(collection(turns, url));
    if (init.method === "GET" && url.pathname.endsWith("/items")) return jsonResponse(collection(items, url));
    if (init.method === "GET" && url.pathname === `/v1/agents/sessions/${sessionId}`) {
      return jsonResponse({ id: sessionId, status: pending.length ? "requires_action" : "idle", required_actions: pending });
    }
    throw new Error(`UNEXPECTED_FIXTURE_ROUTE:${init.method}:${url.pathname}`);
  };
  return { sessionId, calls, inputs, turns, items, toolResults, fetchImpl, addInput,
    get createCount() { return createCount; }, get createPayload() { return createPayload; } };
}
