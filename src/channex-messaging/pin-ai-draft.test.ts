import assert from "node:assert/strict";
import test from "node:test";
import { createPinAIInboxDrafts, type DraftHistory } from "./pin-ai-draft.js";
import { buildPinAIInboxDraftRuntime, draftTools, pinAIDraftsEnabled } from "./pin-ai-draft.runtime.js";
import { createConversationMemory } from "../pin-ai/runtime/conversation-memory.js";
import type { PinAIRuntimeRequest } from "../pin-ai/runtime/contracts.js";

const scope = { organizationId: "org-a", propertyId: "property-a" };
const input = { ...scope, threadId: "thread-a", messageId: "message-a" };
const context = { ...scope, reservationId: null, preferredLanguage: "es" as const, timezone: null };
function history(): DraftHistory {
  return { items: [{ id: "message-a", text: "¿Hay estacionamiento?", sender: "guest", insertedAt: "2026-10-03T16:00:00Z", attachments: [] }], page: 1, limit: 25, total: 1,
    thread: { id: "thread-a", title: "Inquiry", provider: "Airbnb", isClosed: false, bookingId: null, messageCount: 1, lastMessage: null, updatedAt: "2026-10-03T16:00:00Z" } };
}
function harness(overrides: Partial<Parameters<typeof createPinAIInboxDrafts>[0]> = {}) {
  const calls: string[] = [];
  const draft = createPinAIInboxDrafts({ enabled: () => true,
    messages: async () => { calls.push("read"); return history(); },
    resolveContext: async () => { calls.push("scope"); return context; },
    run: async () => { calls.push("model"); return { text: "Consulta de estacionamiento", requiresHumanReview: true }; }, ...overrides });
  return { draft, calls };
}
test("draft rechecks authoritative history and never reports a sent message", async () => {
  const h = harness(); const result = await h.draft(input);
  assert.equal(result.sent, false); assert.equal(result.requiresHumanReview, true); assert.equal(result.basedOnMessageId, input.messageId);
  assert.deepEqual(h.calls, ["read", "scope", "model", "read"]);
});
test("feature requires explicit organization and property scope", async () => {
  const env = { PIN_AI_CHANNEX_DRAFT_ENABLED: "true", PIN_AI_CHANNEX_DRAFT_ORGANIZATION_IDS: "org-a", PIN_AI_CHANNEX_DRAFT_PROPERTY_IDS: "property-a" };
  assert.equal(pinAIDraftsEnabled(env, scope), true);
  for (const candidate of [{}, { ...env, PIN_AI_CHANNEX_DRAFT_ENABLED: "false" }, { ...env, PIN_AI_CHANNEX_DRAFT_PROPERTY_IDS: "*" }]) assert.equal(pinAIDraftsEnabled(candidate, scope), false);
  assert.equal(pinAIDraftsEnabled(env, { ...scope, organizationId: "org-b" }), false);
  const h = harness({ enabled: () => false }); await assert.rejects(h.draft(input), /DISABLED/); assert.deepEqual(h.calls, []);
});
test("closed, answered, stale, attachment and overlarge conversations do not reach model", async () => {
  for (const mutate of [
    (h: DraftHistory) => { h.thread.isClosed = true; },
    (h: DraftHistory) => { h.items[0]!.sender = "property"; },
    (h: DraftHistory) => { h.items[0]!.id = "new-message"; },
    (h: DraftHistory) => { h.items[0]!.attachments = ["https://attachment.invalid"]; },
    (h: DraftHistory) => { h.items[0]!.text = "x".repeat(24001); },
  ]) {
    const h = harness({ messages: async () => { const value = history(); mutate(value); return value; } });
    await assert.rejects(h.draft(input)); assert.ok(!h.calls.includes("model"));
  }
});
test("another tenant's context is rejected before generation", async () => {
  const h = harness({ resolveContext: async () => ({ ...context, organizationId: "org-b" }) });
  await assert.rejects(h.draft(input), /SCOPE_INVALID/); assert.ok(!h.calls.includes("model"));
});
test("a new guest or host message while generating invalidates the draft", async () => {
  for (const sender of ["guest", "property"] as const) {
    let count = 0;
    const h = harness({ messages: async () => { const value = history(); if (++count > 1) value.items.push({ ...value.items[0]!, id: "new", sender, insertedAt: "2026-10-03T16:01:00Z" }); return value; } });
    await assert.rejects(h.draft(input), /NO_PENDING_MESSAGE/);
  }
});
test("simultaneous generation is bounded and a failure releases the slot", async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ run: async () => { await wait; throw new Error("provider failed"); } });
  const first = h.draft(input); await assert.rejects(h.draft(input), /BUSY/); release(); await assert.rejects(first, /provider failed/);
  await assert.rejects(h.draft(input), /provider failed/);
});
test("inquiries cannot read any reservation and proposals/escalations cannot write", async () => {
  let reads = 0;
  for (const reservationId of [null, "reservation-a"]) {
    const request: PinAIRuntimeRequest = { context: { ...scope, reservationId: reservationId ?? "unlinked-channex-inquiry:thread-a", guestId: "thread-a", currentLocalDateTime: "2026-10-03T16:00:00Z", propertyKnowledge: { ...scope, language: "es", facts: [] } }, conversation: [{ role: "guest", content: "hola" }] };
    const executor = draftTools({ ...context, reservationId }, { execute: async () => { reads++; return { read: true }; } });
    for (const tool of ["prepare_reservation_modification", "escalate_to_host"] as const) {
      const result = await executor.execute(tool, {}, request, createConversationMemory(request)); assert.equal(result.executed, false); assert.equal(result.requiresHumanReview, true);
    }
    await executor.execute("get_reservation_context", {}, request, createConversationMemory(request));
    assert.equal(reads, reservationId ? 1 : 0);
  }
});
test("booking context lookup requires exact provider, booking, property and organization", async () => {
  let query: any;
  const draft = buildPinAIInboxDraftRuntime({ env: { PIN_AI_CHANNEX_DRAFT_ENABLED: "true", PIN_AI_CHANNEX_DRAFT_ORGANIZATION_IDS: "org-a", PIN_AI_CHANNEX_DRAFT_PROPERTY_IDS: "property-a" },
    prisma: { property: { findFirst: async () => ({ timezone: "America/Puerto_Rico" }) }, reservation: { findMany: async (value: any) => { query = value; return []; } } } as any,
    messages: async () => { const h = history(); h.thread.bookingId = "booking-a"; return h; } });
  await assert.rejects(draft(input), /RESERVATION_NOT_LINKED/);
  assert.deepEqual(query.where, { propertyId: "property-a", externalProvider: "CHANNEX", externalId: "booking-a", property: { organizationId: "org-a", status: "ACTIVE" }, status: "ACTIVE" });
  assert.deepEqual(query.select, { id: true, preferredLanguage: true });
});
