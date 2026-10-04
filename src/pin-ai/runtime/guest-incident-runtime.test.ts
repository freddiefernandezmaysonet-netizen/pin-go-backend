import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIAgentsRuntimeTransport } from "./openai-agents-runtime-transport.js";
import { buildPinAIOpenAIAgentConfig } from "./openai-agent-config.js";
import { createTurnFixture } from "./runtime-turn.test-fixture.js";
import { createConversationMemory } from "./conversation-memory.js";
import { assertRuntimeResponseSafe } from "./policy.js";
import type { PinAIRuntimeRequest } from "./contracts.js";
import { GuestIncidentToolExecutor } from "./guest-incident-tool-executor.js";

const request: PinAIRuntimeRequest = { context: { organizationId: "org-a", propertyId: "property-a", reservationId: "reservation-a",
  guestId: "reservation-guest", currentLocalDateTime: "2026-09-27T11:00:00-04:00", preferredLanguage: "es" },
  conversation: [{ role: "guest", content: "El agua sale fría en todos los grifos" }] };
const args = { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["El agua sale fría en todos los grifos"] };
test("incident-enabled runtime executes the tool and returns authoritative receipt, never the model's completion claim", async () => {
  const fixture = createTurnFixture({ actions: () => [{ name: "escalate_to_host", arguments: args }], answer: () => "He notificado al anfitrión y tu reembolso fue aprobado" });
  const transport = new OpenAIAgentsRuntimeTransport({ enabled: true, incidentsEnabled: true, apiKey: "synthetic", model: "gpt-5.6-luna", maxPolls: 3, pollDelayMs: 0 }, fixture.fetchImpl);
  let calls = 0;
  const result = await transport.run(request, createConversationMemory(request), { async execute(tool, actual) {
    calls++; assert.equal(tool, "escalate_to_host"); assert.deepEqual(actual, args);
    return { executed: true, incidentRecorded: true, incidentResponseText: "Incidente registrado para revisión. El aviso está pendiente de envío." };
  } });
  assert.equal(calls, 1); assert.equal(result.escalationCreated, true);
  assert.equal(result.responseText, "Incidente registrado para revisión. El aviso está pendiente de envío.");
  assertRuntimeResponseSafe(result);
});
test("default-off transport keeps escalation shadow and never invokes an incident writer", async () => {
  const fixture = createTurnFixture({ actions: () => [{ name: "escalate_to_host", arguments: {} }] });
  const transport = new OpenAIAgentsRuntimeTransport({ enabled: true, apiKey: "synthetic", model: "gpt-5.6-luna", maxPolls: 3, pollDelayMs: 0 }, fixture.fetchImpl);
  const result = await transport.run(request, createConversationMemory(request), { async execute() { assert.fail("disabled tool must not execute"); } });
  assert.equal(result.escalationCreated, false);
  assert.equal(JSON.parse(fixture.toolResults[0]!.output as string).reason, "SHADOW_MODE_ESCALATION_NOT_EXECUTED");
});
test("enabled tool must return a persisted receipt contract before a response is accepted", async () => {
  const fixture = createTurnFixture({ actions: () => [{ name: "escalate_to_host", arguments: args }] });
  const transport = new OpenAIAgentsRuntimeTransport({ enabled: true, incidentsEnabled: true, apiKey: "synthetic", model: "gpt-5.6-luna", maxPolls: 3, pollDelayMs: 0 }, fixture.fetchImpl);
  await assert.rejects(transport.run(request, createConversationMemory(request), { async execute() { return { executed: true }; } }), /RECEIPT_REQUIRED/);
});
test("status lookup is read-only even when it finds an open case", async () => {
  const fixture = createTurnFixture({ actions: () => [{ name: "escalate_to_host", arguments: { ...args, operation: "STATUS", guestQuotes: [] } }] });
  const transport = new OpenAIAgentsRuntimeTransport({ enabled: true, incidentsEnabled: true, apiKey: "synthetic", model: "gpt-5.6-luna", maxPolls: 3, pollDelayMs: 0 }, fixture.fetchImpl);
  const result = await transport.run(request, createConversationMemory(request), { async execute() {
    return { executed: false, incidentRecorded: true, incidentResponseText: "El incidente sigue pendiente de resolución." };
  } });
  assert.equal(result.escalationCreated, false); assert.match(result.responseText, /pendiente/);
});
test("enabled manifest changes only escalation schema; baseline read/action tools remain unchanged", () => {
  const baseline = buildPinAIOpenAIAgentConfig(undefined, { enabled: true }) as any;
  const enabled = buildPinAIOpenAIAgentConfig(undefined, { enabled: true }, true) as any;
  assert.deepEqual(baseline.tools.filter((t: any) => t.name !== "escalate_to_host"), enabled.tools.filter((t: any) => t.name !== "escalate_to_host"));
  assert.deepEqual(enabled.tools.find((t: any) => t.name === "escalate_to_host").parameters.required, ["operation", "category", "guestQuotes"]);
  assert.match(enabled.instructions, /never assistant advice/);
  assert.deepEqual(enabled.tools.find((t: any) => t.name === "escalate_to_host").parameters.properties.responseLanguage.enum, ["es", "en"]);
  assert.match(enabled.instructions, /latest guest message/);
  assert.match(enabled.instructions, /language-neutral/);
  assert.match(enabled.instructions, /Never infer the guest language from assistant or host messages/);
  assert.match(enabled.instructions, /omit responseLanguage/);
  assert.notEqual(enabled.instructions, baseline.instructions);
});

test("portal and channel incident receipts honor conversation language over reservation language without changing incident state", async () => {
  for (const channel of [false, true]) {
    for (const responseLanguage of ["es", "en", undefined] as const) {
      const preferredLanguage: "en" | "es" = responseLanguage === "es" ? "en" : "es";
      const turn = { ...request, context: { ...request.context, preferredLanguage },
        conversation: [{ role: "guest" as const, content: responseLanguage === "en" ? "Is the hot water issue resolved?" : "¿Se resolvió el problema del agua caliente?" }] };
      let reads = 0;
      const tx = {
        reservation: { async findFirst() { reads++; return { id: "reservation-a", reservationNumber: "PG-TEST", property: { name: "Test" } }; } },
        channexAIInbound: { async findFirst() { return { leaseToken: "lease" }; } },
        channexAIThread: { async updateMany() { return { count: 1 }; } },
        async $executeRawUnsafe() {},
        operationalIssue: { async findFirst() { return { id: "issue-a", metadata: { reference: "GI-TEST" }, workflowState: "RESOLVED" }; } },
        messageLog: { async findMany() { return [{ status: "SENT", providerDeliveryStatus: "DELIVERED" }]; } },
        pinAIHostIncidentThread: { async findFirst() { return { acknowledgedAt: new Date() }; } },
      };
      const executor = new GuestIncidentToolExecutor({
        prisma: { async $transaction(run: any) { return run(tx); } } as any,
        ...(channel ? { channel: { bookingId: "booking", threadId: "thread", messageId: "message" } } : { guestToken: "synthetic" }),
        env: { PIN_AI_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_CANARY_RESERVATION_IDS: "reservation-a",
          PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_START_AT: "2026-10-03T00:00:00Z",
          PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS: "org-a", PIN_AI_CHANNEX_AUTO_PROPERTY_IDS: "property-a" },
        delegate: { async execute() { assert.fail("incident must use canonical service"); } },
      });
      const result = await executor.execute("escalate_to_host", { ...args, operation: "STATUS", guestQuotes: [],
        ...(responseLanguage ? { responseLanguage } : {}) }, turn, createConversationMemory(turn));
      assert.equal(reads, 1);
      assert.equal(result.executed, false);
      assert.equal((result.receipt as any).resolution, "RESOLVED");
      assert.match(String(result.incidentResponseText), (responseLanguage ?? preferredLanguage) === "es" ? /resuelto/ : /resolved/);
      assert.equal(turn.context.preferredLanguage, preferredLanguage);
    }
  }
});

test("invalid incident language is rejected before any database operation", async () => {
  for (const responseLanguage of ["fr", "ES", null, 1, {}]) {
    const executor = new GuestIncidentToolExecutor({ prisma: { async $transaction() { assert.fail("must reject before writes"); } } as any,
      guestToken: "synthetic", env: {}, delegate: { async execute() { return {}; } } });
    await assert.rejects(executor.execute("escalate_to_host", { ...args, responseLanguage }, request, createConversationMemory(request)), /RESPONSE_LANGUAGE_INVALID/);
  }
});
