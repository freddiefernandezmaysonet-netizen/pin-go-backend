import assert from "node:assert/strict";
import test from "node:test";
import type { PinAIRuntimeRequest, PinAIRuntimeToolName } from "./contracts.js";
import { createConversationMemory } from "./conversation-memory.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { OpenAIAgentsRuntimeTransport, type RuntimeFetch, type OpenAIRuntimeTransportConfig } from "./openai-agents-runtime-transport.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";
import { createTurnFixture, jsonResponse, page, type TestItem } from "./runtime-turn.test-fixture.js";

const request: PinAIRuntimeRequest = {
  context: { organizationId: "org-a", propertyId: "property-a", reservationId: "reservation-a",
    guestId: "guest-a", currentLocalDateTime: "2026-09-20T11:00:00-04:00", preferredLanguage: "en" },
  conversation: [{ role: "guest", content: "The AC still isn't cooling after the reset." }],
};
const noTools: PinAIRuntimeToolExecutor = { async execute() { throw new Error("UNEXPECTED_TOOL"); } };
function transport(fetchImpl: RuntimeFetch, config: Partial<OpenAIRuntimeTransportConfig> = {}) {
  return new OpenAIAgentsRuntimeTransport({ enabled: true, apiKey: "test-key", model: "gpt-5.6-luna",
    maxPolls: 3, pollDelayMs: 0, ...config }, fetchImpl);
}
function run(t: OpenAIAgentsRuntimeTransport, tools = noTools) {
  return new LunaRuntimeAdapter(t).run(request, createConversationMemory(request), tools);
}
function resumed() {
  const f = createTurnFixture();
  f.addInput("previous guest message");
  return f;
}

test("Luna runtime adapter executes read tools but shadows escalation", async () => {
  const f = createTurnFixture({ actions: () => [{ name: "get_property_knowledge" }, { name: "escalate_to_host" }],
    answer: () => "I checked the property guidance and would escalate this for review." });
  const executed: string[] = [];
  const result = await run(transport(f.fetchImpl), { async execute(name) {
    executed.push(name); return { acGuidance: "Escalate after exhausted reset." };
  } });
  assert.deepEqual(executed, ["get_property_knowledge"]);
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["get_property_knowledge", "escalate_to_host"]);
  assert.equal(result.escalationCreated, false);
  assert.equal(result.requiresHumanReview, true);
  assert.match(result.responseText, /would escalate/i);
  assert.equal(JSON.parse(f.toolResults[1]?.output as string).executed, false);
});

test("runtime transport fails closed before network for invalid configuration", async () => {
  for (const [config, error] of [
    [{ enabled: false }, /OPENAI_DISABLED/],
    [{ apiKey: "" }, /OPENAI_API_KEY_MISSING/],
    [{ agentId: "not-an-agent" }, /OPENAI_AGENT_ID_INVALID/],
    [{ resumeSessionId: "not-a-session-id" }, /OPENAI_SESSION_ID_INVALID/],
    [{ maxPolls: -1 }, /POLL_LIMIT_INVALID/],
  ] as const) {
    let calls = 0;
    await assert.rejects(run(transport(async () => { calls += 1; throw new Error("NETWORK"); }, config)), error);
    assert.equal(calls, 0);
  }
});

test("runtime preserves sanitized diagnostics from a failed OpenAI session", async () => {
  const t = transport(async () => jsonResponse({ id: "sess_failed", status: "failed", error: {
    type: "server_error", code: "agent_internal_error", message: "An internal error occurred. sk-sensitive Bearer sensitive",
  } }));
  await assert.rejects(run(t), (error: unknown) => {
    assert.match((error as Error).message, /PIN_AI_RUNTIME_AGENT_SESSION_FAILED:type=server_error;code=agent_internal_error/);
    assert.doesNotMatch((error as Error).message, /sk-sensitive|Bearer sensitive/);
    return true;
  });
});

test("runtime marks review metadata from eligibility and pricing decisions", async () => {
  const cases: Array<[PinAIRuntimeToolName, Record<string, unknown>]> = [
    ["check_late_checkout", { decision: "OPERATIONALLY_AVAILABLE_FOR_REVIEW" }],
    ["calculate_extension_price", { decision: "PRICE_CALCULATED_FOR_REVIEW" }],
    ["calculate_extension_price", { decision: "PRICE_REQUIRES_HUMAN_REVIEW", pricingReviewRequired: true }],
    ["check_date_change", { decision: "DATE_CHANGE_AVAILABLE_FOR_REVIEW" }],
    ["get_property_knowledge", { requiresHumanReview: true }],
  ];
  for (const [tool, output] of cases) {
    const f = createTurnFixture({ actions: () => [{ name: tool }] });
    const result = await run(transport(f.fetchImpl), { async execute(name) { assert.equal(name, tool); return output; } });
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.escalationCreated, false);
  }
});

test("runtime does not mark unavailable eligibility as human review", async () => {
  const f = createTurnFixture({ actions: () => [{ name: "check_extension_availability" }] });
  const result = await run(transport(f.fetchImpl), { async execute() { return { decision: "NOT_AVAILABLE", authorizationGranted: false }; } });
  assert.equal(result.requiresHumanReview, false);
});

test("runtime advertises exactly 13 canonical functions and preserves shadow instructions", async () => {
  const f = createTurnFixture();
  await run(transport(f.fetchImpl, { agentId: "agent_saved123" }));
  assert.equal(f.createPayload.agent_id, "agent_saved123");
  const agent = f.createPayload.agent as { tools: TestItem[]; instructions: string };
  assert.deepEqual(agent.tools.map((tool) => tool.name), ["get_property_knowledge", "get_reservation_context",
    "get_guest_journey_status", "get_access_status", "get_cleaning_status", "check_early_checkin",
    "check_late_checkout", "check_extension_availability", "calculate_extension_price", "check_date_change",
    "get_cancellation_policy", "get_payment_context", "escalate_to_host"]);
  for (const phrase of [/extension pricing as an estimate for review only/i, /date-change availability and pricing as an estimate for host review only/i,
    /cancellation-policy results and refund amounts as read-only estimates/i, /payment context as read-only persisted history only/i]) {
    assert.match(agent.instructions, phrase);
  }
  assert.equal(agent.tools.some((tool) => tool.type === "web_search"), false);
});

test("runtime proposal tool is absent by default and fails closed if OpenAI requests it anyway", async () => {
  const f = createTurnFixture({
    actions: () => [{
      name: "prepare_reservation_modification",
      arguments: {
        proposedCheckInDate: "2026-10-01",
        proposedCheckOutDate: "2026-10-05",
      },
    }],
  });
  let executed = 0;

  await assert.rejects(
    run(
      transport(f.fetchImpl),
      {
        async execute() {
          executed += 1;
          return {};
        },
      },
    ),
    /ACTION_PROPOSAL_TOOL_DISABLED/,
  );

  assert.equal(executed, 0);
  const agent = f.createPayload.agent as {
    tools: TestItem[];
  };
  assert.equal(
    agent.tools.some(
      (tool) =>
        tool.name ===
        "prepare_reservation_modification",
    ),
    false,
  );
});

test("runtime advertises and executes the proposal-only tool only when explicitly enabled", async () => {
  const f = createTurnFixture({
    actions: () => [{
      name: "prepare_reservation_modification",
      arguments: {
        proposedCheckInDate: "2026-10-01",
        proposedCheckOutDate: "2026-10-05",
      },
    }],
    answer: () =>
      "I prepared a quote that is valid until the time shown. Availability is not held; use the confirmation control to continue.",
  });
  const executed: PinAIRuntimeToolName[] = [];

  const result = await run(
    transport(
      f.fetchImpl,
      {
        actionProposal: {
          enabled: true,
        },
      },
    ),
    {
      async execute(name) {
        executed.push(name);
        return {
          decision:
            "ACTION_PROPOSAL_PREPARED",
          proposalId:
            "proposal-12345678",
          requiresGuestConfirmation:
            true,
          actionExecuted: false,
          availabilityHeld: false,
          quote: {
            quoteExpiresAtLocal:
              "2026-09-26T11:00:00-04:00",
          },
        };
      },
    },
  );

  assert.deepEqual(
    executed,
    ["prepare_reservation_modification"],
  );
  assert.deepEqual(
    result.toolCalls.map(
      (call) => call.name,
    ),
    ["prepare_reservation_modification"],
  );
  assert.equal(
    result.escalationCreated,
    false,
  );

  const agent = f.createPayload.agent as {
    tools: TestItem[];
    instructions: string;
  };
  assert.equal(
    agent.tools.filter(
      (tool) =>
        tool.type === "function",
    ).length,
    14,
  );
  assert.equal(
    agent.tools.some(
      (tool) =>
        tool.name ===
        "prepare_reservation_modification",
    ),
    true,
  );
  assert.match(
    agent.instructions,
    /exact quote expiration/i,
  );
  assert.match(
    agent.instructions,
    /confirmation control/i,
  );
  assert.match(
    agent.instructions,
    /Never ask the guest to type or repeat a confirmation token/i,
  );
});

test("runtime advertises opt-in native web search separately and scopes its evidence by turn", async () => {
  const f = resumed();
  f.items.splice(1, 0, { id: "web_old", turn_id: "turn_1", type: "web_search_call", status: "completed" });
  const fetchImpl: RuntimeFetch = async (url, init) => {
    const response = await f.fetchImpl(url, init);
    if (f.inputs.length === 2 && !f.items.some((item) => item.id === "web_new")) {
      f.items.push({ id: "web_new", turn_id: "turn_2", type: "web_search_call", status: "completed" });
    }
    return response;
  };
  const result = await run(transport(fetchImpl, { resumeSessionId: f.sessionId, webSearch: { enabled: true, mode: "live" } }));
  assert.deepEqual(result.webSearch, { enabled: true, used: true, callCount: 1 });
  const fresh = createTurnFixture();
  await run(transport(fresh.fetchImpl, { webSearch: { enabled: true, mode: "live",
    location: { country: "PR", region: "Puerto Rico", city: "San Juan", timezone: "America/Puerto_Rico" } } }));
  const tools = (fresh.createPayload.agent as { tools: TestItem[] }).tools;
  assert.deepEqual(tools[0], { type: "web_search", mode: "live", location: { country: "PR", region: "Puerto Rico", city: "San Juan", timezone: "America/Puerto_Rico" } });
  assert.equal(tools.filter((tool) => tool.type === "function").length, 13);
  assert.equal(tools.some((tool) => tool.name === "search_local_places"), false);
});

test("runtime preserves read-only function and web-search evidence in the same completed turn", async () => {
  const f = createTurnFixture({ actions: () => [{ name: "check_late_checkout", arguments: { requestedLocalTime: "13:00" } }] });
  const fetchImpl: RuntimeFetch = async (url, init) => {
    const r = await f.fetchImpl(url, init);
    if (f.inputs.length && !f.items.some((item) => item.id === "web_1")) {
      f.items.push({ id: "web_1", type: "web_search_call", turn_id: "turn_1", status: "completed" });
    }
    return r;
  };
  const result = await run(transport(fetchImpl, { webSearch: { enabled: true } }), { async execute(name, args) {
    assert.equal(name, "check_late_checkout"); assert.deepEqual(args, { requestedLocalTime: "13:00" });
    return { decision: "OPERATIONALLY_AVAILABLE_FOR_REVIEW", authorizationGranted: false };
  } });
  assert.equal(result.requiresHumanReview, true); assert.equal(result.webSearch?.callCount, 1);
});

test("runtime rejects disabled tools and invalid arguments before execution", async () => {
  for (const action of [{ name: "search_local_places" }, ...[null, "{}", []].map((arguments_) => ({ name: "get_access_status", arguments: arguments_ }))]) {
    let executed = 0;
    const f = createTurnFixture({ actions: () => [action] });
    await assert.rejects(run(transport(f.fetchImpl), { async execute() { executed += 1; return {}; } }), /UNAPPROVED_TOOL|TOOL_ARGUMENTS_INVALID/);
    assert.equal(executed, 0);
  }
});

for (const scenario of ["propagates", "changed", "never-clears"] as const) {
test(`runtime handles an acknowledged required action: ${scenario}`, async () => {
  const f = createTurnFixture({ actions: () => [{ name: "get_access_status" }] });
  let accepted = false;
  let staleRead = false;
  let savedSession: any;
  let count = 0;
  const fetchImpl: RuntimeFetch = async (url, init) => {
    const response = await f.fetchImpl(url, init);
    if (init.method === "GET" && url.endsWith(`/${f.sessionId}`)) {
      if (!accepted) savedSession = await response.json();
      else if (!staleRead || scenario === "never-clears") {
        staleRead = true;
        const stale = structuredClone(savedSession);
        if (scenario === "changed") stale.required_actions[0].arguments = { unexpected: "changed" };
        return jsonResponse(stale);
      }
    }
    if (init.method === "POST" && url.endsWith("/events")) accepted = true;
    if (accepted && (!staleRead || scenario === "never-clears") && url.endsWith("/turns?limit=100&order=asc")) {
      return jsonResponse(page(f.turns.map(turn => ({ ...turn, status: "waiting" }))));
    }
    return response;
  };
  const pending = run(transport(fetchImpl), { async execute() { count += 1; return {}; } });
  if (scenario === "propagates") {
    const result = await pending;
    assert.equal(result.responseText, "Checked.");
    assert.equal(result.toolCalls.length, 1);
  } else {
    await assert.rejects(pending, scenario === "changed"
      ? /TOOL_CALL_ID_REUSED_WITH_CHANGED_PAYLOAD/ : /TURN_POLL_LIMIT/);
  }
  assert.equal(staleRead, true);
  assert.equal(count, 1);
  assert.equal(f.toolResults.length, 1);
});
}

test("runtime rejects repeated call IDs and mixed-turn actions without duplicate execution", async () => {
  const f = createTurnFixture({ actions: () => [
    { name: "get_access_status", call_id: "same" }, { name: "get_access_status", call_id: "same" },
  ] });
  let count = 0;
  await assert.rejects(run(transport(f.fetchImpl), { async execute() { count += 1; return {}; } }), /DUPLICATE_TOOL_CALL_ID/);
  assert.equal(count, 0);
  const mixed = createTurnFixture({ actions: () => [
    { name: "get_access_status" }, { name: "get_cleaning_status", turn_id: "turn_foreign" },
  ] });
  count = 0;
  await assert.rejects(run(transport(mixed.fetchImpl), { async execute() { count += 1; return {}; } }), /REQUIRED_ACTION_TURN_MISMATCH/);
  assert.equal(count, 0);
});

test("runtime accepts sess_ and session_ IDs but does not follow a changed session ID", async () => {
  for (const sessionId of ["sess_valid", "session_valid"]) {
    const f = createTurnFixture({ sessionId }); f.addInput("earlier");
    const result = await run(transport(f.fetchImpl, { resumeSessionId: sessionId }));
    assert.equal(result.openaiSessionId, sessionId);
    assert.equal(f.createCount, 0);
  }
  let posts = 0;
  await assert.rejects(run(transport(async (_url, init) => {
    if (init.method === "POST") posts += 1;
    return jsonResponse({ id: "sess_other", status: "idle" });
  }, { resumeSessionId: "sess_valid" })), /SESSION_ID_MISMATCH/);
  assert.equal(posts, 0);
});

test("idle after submission waits for a new completed root turn, not the previous answer", async () => {
  const f = resumed();
  let newTurnReads = 0;
  const fetchImpl: RuntimeFetch = async (url, init) => {
    const r = await f.fetchImpl(url, init);
    if (url.includes("/turns?") && f.inputs.length === 2 && ++newTurnReads < 3) {
      return jsonResponse(page([f.turns[0]!]));
    }
    return r;
  };
  const t = transport(fetchImpl, { resumeSessionId: f.sessionId });
  const result = await run(t);
  assert.equal(newTurnReads, 3);
  assert.equal(result.responseText, "Checked."); // Equal text is fine only with NEW IDs.
  assert.deepEqual(t.getCompletedTurnEvidence(), { sessionId: f.sessionId, turnId: "turn_2", assistantMessageId: "msg_assistant_2", status: "completed" });
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});

test("no new turn cannot pass, even when a previous answer contains the expected marker", async () => {
  const f = resumed(); f.items[1]!.content = [{ type: "output_text", text: "PIN-AI-ORBIT-47" }];
  const t = transport(async (url, init) => {
    const r = await f.fetchImpl(url, init);
    return url.includes("/turns?") && f.inputs.length === 2 ? jsonResponse(page([f.turns[0]!])) : r;
  }, { resumeSessionId: f.sessionId, maxPolls: 1 });
  await assert.rejects(run(t), /TURN_POLL_LIMIT/);
  assert.equal(t.getCompletedTurnEvidence(), null);
});

for (const state of ["queued", "in_progress", "waiting", "failed", "cancelled"]) {
  test(`a ${state} new turn is not certified by idle session status or existing text`, async () => {
    const f = resumed();
    const t = transport(async (url, init) => {
      const r = await f.fetchImpl(url, init);
      if (url.includes("/turns?") && f.inputs.length === 2) {
        return jsonResponse(page([{ ...f.turns[1], status: state }]));
      }
      return r;
    }, { resumeSessionId: f.sessionId, maxPolls: 1 });
    await assert.rejects(run(t), /TURN_POLL_LIMIT|TURN_FAILED|TURN_CANCELLED/);
    assert.equal(t.getCompletedTurnEvidence(), null);
  });
}

for (const replacement of [
  { status: "in_progress" }, { status: "incomplete" }, { status: undefined },
  { phase: "commentary" }, { phase: undefined }, { turn_id: "turn_1" }, { turn_id: undefined },
  { id: "msg_assistant_1" }, { id: null }, { content: [] },
]) {
  test(`rejects stale, incomplete or unidentifiable reply: ${JSON.stringify(replacement)}`, async () => {
    const f = resumed();
    const t = transport(async (url, init) => {
      const r = await f.fetchImpl(url, init);
      if (url.includes("/items?") && f.inputs.length === 2) {
        return jsonResponse(page([f.items[2]!, { ...f.items[3], ...replacement }]));
      }
      return r;
    }, { resumeSessionId: f.sessionId, maxPolls: 1 });
    await assert.rejects(run(t), /TURN_POLL_LIMIT|MESSAGE_ID_INVALID/);
    assert.equal(t.getCompletedTurnEvidence(), null);
  });
}

test("completed turn waits for delayed item persistence and counts only its web calls", async () => {
  const f = resumed(); let reads = 0;
  const t = transport(async (url, init) => {
    const r = await f.fetchImpl(url, init);
    if (url.includes("/items?") && f.inputs.length === 2 && ++reads < 3) {
      return jsonResponse(page([f.items[2]!, { ...f.items[3], status: "in_progress" }]));
    }
    return r;
  }, { resumeSessionId: f.sessionId });
  assert.equal((await run(t)).webSearch?.callCount, 0);
  assert.equal(reads, 3);
});

test("unrelated input, wrong-session turns, and multiple root turns fail closed", async () => {
  for (const fault of ["input", "session", "ambiguous"] as const) {
    const f = resumed();
    const t = transport(async (url, init) => {
      const r = await f.fetchImpl(url, init);
      if (f.inputs.length < 2) return r;
      if (fault === "input" && url.includes("/items?")) return jsonResponse(page([
        { ...f.items[2], content: [{ type: "input_text", text: "another person's request" }] }, f.items[3]!,
      ]));
      if (fault === "session" && url.includes("/turns?")) return jsonResponse(page([{ ...f.turns[1], session_id: "sess_other" }]));
      if (fault === "ambiguous" && url.includes("/turns?")) return jsonResponse(page([f.turns[1]!, { ...f.turns[1], id: "turn_racing" }]));
      return r;
    }, { resumeSessionId: f.sessionId });
    await assert.rejects(run(t), /INPUT_MISMATCH|TURN_IDENTITY_INVALID|TURN_AMBIGUOUS/);
  }
});

test("subagent completion never substitutes for a root turn", async () => {
  const f = resumed();
  await assert.rejects(run(transport(async (url, init) => {
    const r = await f.fetchImpl(url, init);
    return f.inputs.length === 2 && url.includes("/turns?") ?
      jsonResponse(page([{ ...f.turns[1], subagent_id: "sub_1" }])) : r;
  }, { resumeSessionId: f.sessionId, maxPolls: 0 })), /TURN_POLL_LIMIT/);
});

test("pagination reads beyond 100 items and preserves the pre-submit boundary", async () => {
  const f = createTurnFixture();
  for (let i = 0; i < 105; i += 1) f.addInput(`old_${i}`);
  const result = await run(transport(f.fetchImpl, { resumeSessionId: f.sessionId }));
  assert.equal(result.responseText, "Checked.");
  assert.equal(f.calls.some((call) => call.url.includes("after=turn_100")), true);
  assert.equal(f.calls.some((call) => call.url.includes("after=msg_assistant_50")), true);
  assert.equal(f.createCount, 0);
});

test("pagination follows later current-turn output and rejects malformed or looping cursors", async () => {
  const f = createTurnFixture(); let itemReads = 0;
  await run(transport(async (url, init) => {
    const r = await f.fetchImpl(url, init);
    if (url.includes("/items?") && ++itemReads === 1) {
      return jsonResponse({ ...page([f.items[0]!]), has_more: true });
    }
    return r;
  }));
  assert.equal(itemReads, 2);
  for (const payload of [ { data: [] }, { data: [], has_more: true, last_id: "x" },
    { data: [{ id: "x" }], has_more: true, last_id: "different" } ]) {
    await assert.rejects(run(transport(async (url) => url.endsWith("/sessions") ?
      jsonResponse({ id: "sess_x", status: "idle" }) : jsonResponse(payload))), /COLLECTION_/);
  }
  const t = transport(async (url) => url.endsWith("/sessions") ? jsonResponse({ id: "sess_x", status: "idle" }) :
    jsonResponse({ data: [{ id: "x" }], has_more: true, last_id: "x" }));
  await assert.rejects(run(t), /COLLECTION_DUPLICATE_ID|COLLECTION_CURSOR_INVALID/);
});

test("failed resumed session and pending baseline root prevent a second input", async () => {
  const f = resumed(); f.turns[0]!.status = "queued";
  await assert.rejects(run(transport(f.fetchImpl, { resumeSessionId: f.sessionId })), /SESSION_BUSY/);
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
});


test("event acknowledgements may have an empty body without losing turn correlation", async () => {
  const f = resumed();
  const result = await run(transport(async (url, init) => {
    const response = await f.fetchImpl(url, init);
    if (init.method === "POST" && url.endsWith("/events")) {
      return { ok: true, status: 204, async json() { throw new SyntaxError("Empty body"); } };
    }
    return response;
  }, { resumeSessionId: f.sessionId }));
  assert.equal(result.responseText, "Checked.");
  assert.equal(f.inputs.length, 2);
});

test("collection reads have a finite page budget", async () => {
  let pages = 0;
  const t = transport(async (url) => {
    if (url.endsWith("/sessions")) return jsonResponse({ id: "sess_x", status: "idle" });
    pages += 1;
    return jsonResponse({ ...page([{ id: `item_${pages}` }]), has_more: true });
  });
  await assert.rejects(run(t), /COLLECTION_PAGE_LIMIT/);
  assert.equal(pages, 10);
});

for (const transition of ["legacy", "enable", "disable", "unchanged", "other-reservation"] as const) {
  test(`guest session configuration: ${transition}`, async () => {
    const oldSession = createTurnFixture({ sessionId: "sess_old" });
    const newSession = createTurnFixture({ sessionId: "sess_new" });
    const calls: string[] = [];
    let creatingOld = true;
    const fetchImpl: RuntimeFetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const f = url.endsWith("/sessions") ? (creatingOld ? oldSession : newSession)
        : url.includes("/sess_old") ? oldSession : newSession;
      const response = await f.fetchImpl(url, init);
      if (init.method === "GET" && new URL(url).pathname === `/v1/agents/sessions/${f.sessionId}`) {
        return jsonResponse({ ...await response.json() as object,
          metadata: transition === "legacy" ? {} : f.createPayload.metadata });
      }
      return response;
    };
    const initiallyEnabled = transition === "disable";
    const config = { requireCurrentSessionConfig: true, actionProposal: { enabled: initiallyEnabled } };
    await run(transport(fetchImpl, config));
    oldSession.items.push({ id: "private_tool", type: "function_call_output", role: "tool",
      turn_id: "turn_1", status: "completed", content: [{ type: "input_text", text: "PRIVATE_PROPOSAL_SENTINEL" }] });
    creatingOld = false;
    calls.length = 0;
    const enabled = transition === "enable";
    const nextRequest = transition === "other-reservation"
      ? { ...request, context: { ...request.context, reservationId: "reservation-b" } } : request;
    const t = transport(fetchImpl, { ...config, actionProposal: { enabled }, resumeSessionId: "sess_old" });
    const result = await new LunaRuntimeAdapter(t).run(nextRequest, createConversationMemory(nextRequest), noTools);
    const rotates = transition !== "unchanged";
    assert.equal(result.openaiSessionId, rotates ? "sess_new" : "sess_old");
    assert.equal(newSession.createCount, rotates ? 1 : 0);
    assert.equal(calls.includes("POST /v1/agents/sessions/sess_old/events"), !rotates);
    if (rotates) {
      const agent = newSession.createPayload.agent as { instructions: string; tools: { name?: string; type: string }[] };
      assert.equal(agent.tools.some(t => t.name === "prepare_reservation_modification"), enabled);
      assert.equal(agent.tools.filter(t => t.type === "function").length, enabled ? 14 : 13);
      assert.equal(agent.instructions.includes("EXTEND_CHECKOUT_ONLY"), enabled);
      const input = JSON.parse(newSession.inputs[0]!);
      assert.deepEqual(input.conversation, nextRequest.conversation);
      assert.deepEqual(input.memory, createConversationMemory(nextRequest));
      assert.equal(input.context.reservationId, nextRequest.context.reservationId);
      assert.deepEqual(input.priorConversationForContextOnly, transition === "other-reservation" ? [] : [
        ...request.conversation, { role: "assistant", content: "Checked." },
      ]);
      assert.equal(newSession.inputs[0]!.includes("PRIVATE_PROPOSAL_SENTINEL"), false);
      assert.match(input.historyConstraint, /never current pricing/);
    }
  });
}

test("configuration rotation cannot bypass a busy existing session", async () => {
  const f = resumed();
  f.turns[0]!.status = "queued";
  await assert.rejects(run(transport(f.fetchImpl, {
    resumeSessionId: f.sessionId, requireCurrentSessionConfig: true,
    actionProposal: { enabled: true },
  })), /SESSION_BUSY/);
  assert.equal(f.calls.some(c => c.method === "POST"), false);
});

test("leased guest recovery starts a fresh turn without replaying an interrupted stay-time proposal", async () => {
  const old = createTurnFixture({ sessionId: "sess_interrupted", actions: () => [
    { name: "prepare_reservation_modification", arguments: { operation: "LATE_CHECKOUT", requestedLocalTime: "12:30" } },
  ] });
  const config = { actionProposal: { enabled: true, stayTimeEnabled: true } };
  await assert.rejects(run(transport(old.fetchImpl, config), { async execute() {
    throw new Error("STAY_TIME_QUOTE_EXPIRED");
  } }), /STAY_TIME_QUOTE_EXPIRED/);
  old.items.push({ id: "secret", type: "function_call_output", role: "tool", turn_id: "turn_1",
    content: [{ type: "input_text", text: "PRIVATE_CONFIRMATION_SENTINEL" }] });
  old.calls.length = 0;
  const fresh = createTurnFixture({ sessionId: "sess_recovered" });
  const fetchImpl: RuntimeFetch = (url, init) => url.includes("/sess_interrupted")
    ? old.fetchImpl(url, init) : fresh.fetchImpl(url, init);
  const result = await run(transport(fetchImpl, { ...config, resumeSessionId: old.sessionId,
    recoverWaitingStayTimeProposal: true }));
  assert.equal(result.openaiSessionId, fresh.sessionId);
  assert.equal(fresh.createCount, 1);
  assert.equal(old.toolResults.length, 0);
  assert.equal(old.calls.some(call => call.method === "POST"), false);
  const input = JSON.parse(fresh.inputs[0]!);
  assert.deepEqual(input.conversation, request.conversation);
  assert.match(input.historyConstraint, /interrupted/);
  assert.equal(fresh.inputs[0]!.includes("PRIVATE_CONFIRMATION_SENTINEL"), false);
});

test("failed guest incident recovery preserves scoped dialogue and never replays the pending report", async () => {
  const old = createTurnFixture({ sessionId: "sess_incident_old", actions: () => [
    { name: "escalate_to_host", arguments: { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["unsupported quote"] } },
  ] });
  await assert.rejects(run(transport(old.fetchImpl, { incidentsEnabled: true }), { async execute() {
    throw new Error("PIN_AI_INCIDENT_UNSUPPORTED_GUEST_QUOTE");
  } }), /UNSUPPORTED_GUEST_QUOTE/);
  old.items.push({ id: "secret", type: "function_call_output", role: "tool", turn_id: "turn_1",
    content: [{ type: "input_text", text: "PRIVATE_INCIDENT_SENTINEL" }] });
  old.calls.length = 0;
  const fresh = createTurnFixture({ sessionId: "sess_incident_new" });
  const fetchImpl: RuntimeFetch = (url, init) => url.includes("/sess_incident_old")
    ? old.fetchImpl(url, init) : fresh.fetchImpl(url, init);
  const result = await run(transport(fetchImpl, { incidentsEnabled: true, resumeSessionId: old.sessionId,
    recoverWaitingIncident: true }));
  assert.equal(result.openaiSessionId, fresh.sessionId);
  assert.equal(old.calls.some(c => c.method === "POST"), false);
  assert.equal(old.toolResults.length, 0);
  const input = JSON.parse(fresh.inputs[0]!);
  assert.deepEqual(input.priorConversationForContextOnly, request.conversation);
  assert.match(input.historyConstraint, /Do not replay/);
  assert.match(input.historyConstraint, /persisted incident status/);
  assert.equal(fresh.inputs[0]!.includes("PRIVATE_INCIDENT_SENTINEL"), false);
});

for (const scenario of ["disabled", "incident-disabled", "other-tool", "in-progress", "mixed"] as const) {
  test(`incident recovery keeps ${scenario} sessions blocked`, async () => {
    let calls = 0;
    const action = { type: "function_call", turn_id: "turn_old", call_id: "call_old",
      name: scenario === "other-tool" ? "prepare_reservation_modification" : "escalate_to_host",
      arguments: { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["Cold water"] } };
    const fetchImpl: RuntimeFetch = async (_url, init) => {
      calls++; assert.equal(init.method, "GET");
      return jsonResponse({ id: "sess_blocked", status: scenario === "in-progress" ? "in_progress" : "requires_action",
        required_actions: scenario === "mixed" ? [action, { ...action, call_id: "call_other", name: "get_access_status", arguments: {} }] : [action] });
    };
    await assert.rejects(run(transport(fetchImpl, { resumeSessionId: "sess_blocked",
      incidentsEnabled: scenario !== "incident-disabled", recoverWaitingIncident: scenario !== "disabled" })), /SESSION_BUSY/);
    assert.equal(calls, 1);
  });
}

for (const scenario of ["disabled", "other-tool", "date-change", "in-progress"] as const) {
  test(`stay-time recovery keeps ${scenario} sessions blocked`, async () => {
    const action = { type: "function_call", turn_id: "turn_old", call_id: "call_old",
      name: scenario === "other-tool" ? "escalate_to_host" : "prepare_reservation_modification",
      arguments: scenario === "date-change" ? { operation: "EXTEND_CHECKOUT_ONLY" }
        : { operation: "LATE_CHECKOUT", requestedLocalTime: "12:30" } };
    let calls = 0;
    const fetchImpl: RuntimeFetch = async (_url, init) => {
      calls++; assert.equal(init.method, "GET");
      return jsonResponse({ id: "sess_blocked", status: scenario === "in-progress" ? "in_progress" : "requires_action",
        required_actions: scenario === "in-progress" ? [] : [action] });
    };
    await assert.rejects(run(transport(fetchImpl, { resumeSessionId: "sess_blocked",
      recoverWaitingStayTimeProposal: scenario !== "disabled",
      actionProposal: { enabled: true, stayTimeEnabled: true } })), /SESSION_BUSY/);
    assert.equal(calls, 1);
  });
}
