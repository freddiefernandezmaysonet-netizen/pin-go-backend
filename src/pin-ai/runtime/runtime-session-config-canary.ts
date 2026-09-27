import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConversationMemory } from "./conversation-memory.js";
import type { PinAIRuntimeRequest, PinAIRuntimeResponse } from "./contracts.js";
import { OpenAIAgentsRuntimeTransport, type RuntimeFetch } from "./openai-agents-runtime-transport.js";

// Explicit, one-shot provider certification. No database or operational executors.
async function main() {
  if (process.argv[2] !== "--run-live") {
    console.log("PIN_AI_SESSION_CONFIG_CANARY_DISABLED");
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  const agentId = process.env.PIN_AI_OPENAI_AGENT_ID;
  assert.ok(apiKey, "OPENAI_API_KEY_REQUIRED");
  assert.ok(agentId, "SAVED_AGENT_ID_REQUIRED");
  const runId = randomUUID();
  const marker = `PINTEST-${runId}`;
  const knownSessions = new Set<string>();
  let creations = 0;
  let requests = 0;
  const deadline = Date.now() + 8 * 60_000;
  const fetchImpl: RuntimeFetch = async (url, init) => {
    assert.ok(++requests <= 300 && Date.now() < deadline, "CANARY_REQUEST_BUDGET_EXCEEDED");
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.openai.com");
    if (parsed.pathname === "/v1/agents/sessions") {
      assert.equal(init.method, "POST");
      assert.ok(++creations <= 3, "UNEXPECTED_SESSION_CREATION");
    } else {
      const match = /^\/v1\/agents\/sessions\/([^/]+)(?:\/(turns|items|events))?$/.exec(parsed.pathname);
      assert.ok(match && knownSessions.has(match[1]!), "OUT_OF_SCOPE_SESSION");
      assert.equal(init.method, match[2] === "events" ? "POST" : "GET");
    }
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const payload = await response.json().catch(() => null);
    if (response.ok && parsed.pathname === "/v1/agents/sessions") {
      assert.equal(typeof payload?.id, "string");
      knownSessions.add(payload.id);
    }
    return { ok: response.ok, status: response.status, async json() { return payload; } };
  };
  const request: PinAIRuntimeRequest = {
    context: { organizationId: `synthetic-org-${runId}`, propertyId: "synthetic-property",
      reservationId: `synthetic-reservation-${runId}`, guestId: "synthetic-guest",
      currentLocalDateTime: new Date().toISOString(), preferredLanguage: "en" },
    conversation: [],
  };
  let previousSession: string | undefined;
  const evidence: { stage: string; sameSession: boolean; functionCount: number }[] = [];
  let firstFingerprint: string | undefined;
  for (const [index, enabled] of [false, true, true, false].entries()) {
    console.log(`PIN_AI_SESSION_CONFIG_CANARY_STAGE_${index + 1}_BEGIN`);
    const current = { ...request, conversation: [{ role: "guest" as const, content: index === 0
      ? `For this synthetic continuity test, remember the code ${marker}. Reply with only that code; do not call any tool.`
      : "What code did I ask you to remember? Reply with only the code; do not call any tool." }] };
    const transport: OpenAIAgentsRuntimeTransport = new OpenAIAgentsRuntimeTransport({ enabled: true, apiKey, agentId,
      model: "gpt-5.6-luna", requireCurrentSessionConfig: true,
      actionProposal: { enabled }, resumeSessionId: previousSession,
      maxPolls: 40, pollDelayMs: 1000 }, fetchImpl);
    const result: PinAIRuntimeResponse = await transport.run(current, createConversationMemory(current), {
      async execute() { throw new Error("CANARY_TOOL_EXECUTION_FORBIDDEN"); },
    });
    assert.equal(result.responseText.trim(), marker, "DIALOGUE_CONTINUITY_FAILED");
    assert.equal(result.toolCalls.length, 0, "UNEXPECTED_TOOL_CALL");
    assert.ok(result.openaiSessionId);
    const sameSession = result.openaiSessionId === previousSession;
    assert.equal(sameSession, index === 2, "SESSION_ROTATION_OR_REUSE_FAILED");
    const response = await fetchImpl(`https://api.openai.com/v1/agents/sessions/${result.openaiSessionId}`, {
      method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "agents=v1" },
    });
    assert.equal(response.ok, true, "SESSION_RETRIEVAL_FAILED");
    const session = await response.json() as {
      metadata: { pin_ai_config_fingerprint: string };
      agent: { tools: { type: string; name?: string }[] };
    };
    assert.match(session.metadata.pin_ai_config_fingerprint, /^[a-f0-9]{64}$/);
    if (index === 0) firstFingerprint = session.metadata.pin_ai_config_fingerprint;
    if (index === 3) assert.equal(session.metadata.pin_ai_config_fingerprint, firstFingerprint);
    const functions = session.agent.tools.filter(tool => tool.type === "function");
    assert.equal(functions.length, enabled ? 14 : 13);
    assert.equal(functions.some(tool => tool.name === "prepare_reservation_modification"), enabled);
    evidence.push({ stage: ["read-only", "enable-proposals", "reuse", "disable-proposals"][index]!,
      sameSession, functionCount: functions.length });
    previousSession = result.openaiSessionId;
  }
  assert.equal(creations, 3);
  console.log(JSON.stringify({ result: "PASS", evidence, syntheticDataOnly: true,
    operationalExecutorsAttached: false, sessionCreations: creations }));
}

main().catch(() => {
  // Do not emit provider payloads, credentials, or conversation text to Railway logs.
  console.error("PIN_AI_SESSION_CONFIG_CANARY_FAILED");
  process.exitCode = 1;
});
