import assert from "node:assert/strict";
import test from "node:test";
import { assertSavedAgentMultiTurnCanaryEnvironment, runSavedAgentMultiTurnCanary } from "./runtime-saved-agent-multiturn-canary.js";
import { createTurnFixture, jsonResponse, page } from "./runtime-turn.test-fixture.js";
import type { RuntimeFetch } from "./openai-agents-runtime-transport.js";

const context = { organizationId: "org-a", propertyId: "property-a", reservationId: "reservation-a",
  preferredLanguage: "en" as const, currentLocalDateTime: "2026-09-24T11:00:00-04:00" };
const markerOf = (inputs: readonly string[]) => {
  const match = inputs[0]?.match(/PIN-AI-[A-F0-9]{32}/);
  assert.ok(match, "first input has a unique synthetic marker");
  return match[0];
};
const options = { apiKey: "test-key", agentId: "agent_saved123", context, maxPolls: 2, pollDelayMs: 0,
  tools: { async execute() { return { reservationStatus: "ACTIVE", accessReady: false }; } } };
function fixture(answer: (marker: string) => string = (marker) => marker) {
  return createTurnFixture({ actions: (n) => n === 1 ? [{ name: "get_reservation_context" }] : [],
    answer: (n, inputs) => n === 1 ? "Your stay is active. The next step is access readiness." : answer(markerOf(inputs)) });
}

test("multi-turn canary fails closed unless every shadow guard is explicit", () => {
  const valid = { PIN_AI_RUNTIME_MULTITURN_CANARY_ENABLED: "true", PIN_AI_RUNTIME_SHADOW_ENABLED: "true",
    PIN_AI_RUNTIME_REAL_READ_ENABLED: "true", PIN_AI_OPENAI_AGENT_ID: "agent_test123", OPENAI_API_KEY: "test-key" };
  assert.deepEqual(assertSavedAgentMultiTurnCanaryEnvironment(valid), { apiKey: "test-key", agentId: "agent_test123" });
  for (const key of ["PIN_AI_RUNTIME_MULTITURN_CANARY_ENABLED", "PIN_AI_RUNTIME_SHADOW_ENABLED", "PIN_AI_RUNTIME_REAL_READ_ENABLED"]) {
    assert.throws(() => assertSavedAgentMultiTurnCanaryEnvironment({ ...valid, [key]: "false" }), /DISABLED/);
  }
  assert.throws(() => assertSavedAgentMultiTurnCanaryEnvironment({ ...valid, OPENAI_API_KEY: "" }), /API_KEY_MISSING/);
  assert.throws(() => assertSavedAgentMultiTurnCanaryEnvironment({ ...valid, PIN_AI_OPENAI_AGENT_ID: "invalid" }), /AGENT_ID_MISSING_OR_INVALID/);
  assert.throws(() => assertSavedAgentMultiTurnCanaryEnvironment({ ...valid, PIN_AI_RUNTIME_WEB_SEARCH_ENABLED: "true" }), /WEB_SEARCH_MUST_BE_DISABLED/);
});

test("one session, two distinct completed turns and exact marker recall are required", async () => {
  const f = fixture();
  const result = await runSavedAgentMultiTurnCanary({ ...options, fetchImpl: f.fetchImpl });
  assert.equal(f.createCount, 1);
  assert.equal(f.inputs.length, 2);
  assert.equal(result.sessionId, f.sessionId);
  assert.equal(result.semanticContinuity, true);
  assert.equal(result.distinctTurns, true);
  assert.equal(result.freshResponsesVerified, true);
  assert.deepEqual(result.firstTurn.toolCalls, ["get_reservation_context"]);
  assert.deepEqual(result.secondTurn.toolCalls, []);
  for (const field of ["actionsExecuted", "databaseWrites", "operationalWrites", "escalationCreated", "webSearchUsed"] as const) {
    assert.equal(result[field], false);
  }
  const marker = markerOf(f.inputs);
  assert.equal(f.inputs[1]?.includes(marker), false);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(result.secondTurn.responseLength, marker.length);
  assert.equal(f.createPayload.agent_id, "agent_saved123");
  const tools = (f.createPayload.agent as { tools: Array<{ type: string; name?: string }> }).tools;
  assert.equal(tools.length, 13);
  assert.equal(tools.every((tool) => tool.type === "function" && tool.name !== "search_local_places"), true);
  const messages = f.calls.filter((call) => call.method === "POST" && call.body?.includes("agent.session.input.message"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.body?.includes(marker), false);
  assert.match(f.inputs[1]!, /What code did I give you in my previous message/);
});

test("marker changes per run and is not leaked into prompts on the second turn", async () => {
  const markers = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    const f = fixture();
    await runSavedAgentMultiTurnCanary({ ...options, fetchImpl: f.fetchImpl });
    markers.add(markerOf(f.inputs));
  }
  assert.equal(markers.size, 3);
});

test("Spanish prompts also require new-turn exact recall", async () => {
  const f = fixture();
  await runSavedAgentMultiTurnCanary({ ...options, context: { ...context, preferredLanguage: "es" }, fetchImpl: f.fetchImpl });
  assert.match(f.inputs[0]!, /No repitas el código/);
  assert.match(f.inputs[1]!, /Responde solo con el código/);
  assert.equal(f.inputs[1]?.includes(markerOf(f.inputs)), false);
});

for (const variant of ["missing", "substring", "lowercase", "fixed-old-marker"] as const) {
  test(`semantic certification rejects ${variant} rather than substring matching`, async () => {
    const f = fixture((marker) => ({ missing: "I do not remember.", substring: `The code is ${marker}.`,
      lowercase: marker.toLowerCase(), "fixed-old-marker": "PIN-AI-ORBIT-47" })[variant]);
    await assert.rejects(runSavedAgentMultiTurnCanary({ ...options, fetchImpl: f.fetchImpl }), /SEMANTIC_CONTINUITY_FAILED/);
  });
}

test("a marker echoed on turn one fails before submitting the second message", async () => {
  const f = createTurnFixture({ answer: (_n, inputs) => markerOf(inputs) });
  await assert.rejects(runSavedAgentMultiTurnCanary({ ...options, fetchImpl: f.fetchImpl }), /MARKER_ECHOED_ON_FIRST_TURN/);
  assert.equal(f.inputs.length, 1);
});

test("no second-turn reply cannot pass by reusing the first response", async () => {
  const f = fixture();
  const fetchImpl: RuntimeFetch = async (url, init) => {
    const r = await f.fetchImpl(url, init);
    if (f.inputs.length === 2 && url.includes("/items?")) {
      return jsonResponse(page([f.items[0]!, f.items[1]!, f.items[2]!]));
    }
    return r;
  };
  await assert.rejects(runSavedAgentMultiTurnCanary({ ...options, fetchImpl }), /TURN_POLL_LIMIT/);
});

test("an incomplete response with the exact marker cannot pass", async () => {
  const f = fixture();
  await assert.rejects(runSavedAgentMultiTurnCanary({ ...options, fetchImpl: async (url, init) => {
    const r = await f.fetchImpl(url, init);
    return f.inputs.length === 2 && url.includes("/items?") ?
      jsonResponse(page([f.items[2]!, { ...f.items[3], status: "in_progress" }])) : r;
  } }), /TURN_POLL_LIMIT/);
});

test("a different session ID on resume is rejected before posting a follow-up", async () => {
  const f = fixture();
  await assert.rejects(runSavedAgentMultiTurnCanary({ ...options, fetchImpl: async (url, init) => {
    const r = await f.fetchImpl(url, init);
    if (init.method === "GET" && new URL(url).pathname === `/v1/agents/sessions/${f.sessionId}` && f.toolResults.length > 0) {
      return jsonResponse({ id: "sess_changed", status: "idle" });
    }
    return r;
  } }), /SESSION_ID_MISMATCH/);
  assert.equal(f.inputs.length, 1);
});

test("identical message ID cannot be relabeled as a new-turn reply", async () => {
  const f = fixture();
  await assert.rejects(runSavedAgentMultiTurnCanary({ ...options, fetchImpl: async (url, init) => {
    const r = await f.fetchImpl(url, init);
    return f.inputs.length === 2 && url.includes("/items?") ?
      jsonResponse(page([f.items[2]!, { ...f.items[3], id: "msg_assistant_1" }])) : r;
  } }), /ASSISTANT_MESSAGE_ID_INVALID/);
});
