import assert from "node:assert/strict";
import test from "node:test";
import { autoConfig, parseMessageEvent, validWebhookSecret } from "./pin-ai-auto.policy.js";
import { createAutomaticResponder } from "./pin-ai-auto.service.js";
import type { AIJob } from "./pin-ai-auto.repository.js";
import type { DraftHistory } from "./pin-ai-draft.js";

const propertyId = "11111111-1111-4111-8111-111111111111", threadId = "22222222-2222-4222-8222-222222222222", messageId = "33333333-3333-4333-8333-333333333333";
const job: AIJob = { id: "job", organizationId: "org", propertyId, threadId, messageId, status: "QUEUED", reason: null, leaseToken: "lease",
  leaseUntil: new Date(Date.now() + 180000), receivedAt: new Date(), updatedAt: new Date(), since: new Date("2026-01-01T00:00:00Z") };
function history(): DraftHistory { return { thread: { id: threadId, title: "Guest", provider: "Airbnb", isClosed: false, bookingId: null, messageCount: 1, updatedAt: "2026-01-02T00:00:00Z", lastMessage: null },
  items: [{ id: messageId, text: "¿Hay parking?", sender: "guest", insertedAt: "2026-01-02T00:00:00Z", attachments: [] }], page: 1, limit: 25, total: 1 }; }
function harness(options: { host?: boolean; review?: boolean; fence?: boolean; sendError?: boolean; change?: boolean; own?: boolean; old?: boolean } = {}) {
  let reads = 0; const sent: any[] = [], outcomes: any[] = [], generated: string[] = [];
  const process = createAutomaticResponder({ enabled: () => true,
    repository: { state: async () => ({ mode: "AUTO", leaseToken: "lease" } as any), ownMessageIds: async () => new Set(options.own ? ["host"] : []),
      fence: async () => options.fence !== false, finish: async (_job, status, reason) => { outcomes.push({ status, reason }); } },
    messages: async () => { const h = history(); reads++;
      if (options.old) h.items[0]!.insertedAt = "2025-12-01T00:00:00Z";
      if (options.host) h.items.unshift({ ...h.items[0]!, id: "host", sender: "property", insertedAt: "2026-01-01T01:00:00Z" });
      if (options.change && reads > 1) h.items.push({ ...h.items[0]!, id: "new", insertedAt: "2026-01-03T00:00:00Z" });
      return h; },
    generate: async () => { generated.push("model"); return { text: "Sí, hay estacionamiento.", requiresHumanReview: !!options.review, basedOnMessageId: messageId, sent: false }; },
    send: async input => { sent.push(input); if (options.sendError) throw new Error("provider timeout, secret must not escape"); },
  });
  return { process, sent, outcomes, generated };
}
test("new verified guest message receives one direct reply with stable delivery identity", async () => {
  const h = harness(); await h.process(job);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].requestedBy, "pin-ai-channex");
  assert.match(h.sent[0].requestKey, /^pin-ai:[a-f0-9]{64}$/); assert.equal(h.outcomes[0].status, "SENT");
});
test("host intervention, escalation, stale messages and lost send fence never send", async () => {
  for (const options of [{ host: true }, { review: true }, { change: true }, { fence: false }, { old: true }]) {
    const h = harness(options); await h.process(job); assert.equal(h.sent.length, 0); assert.notEqual(h.outcomes[0].status, "SENT");
  }
});
test("own AI receipt is distinguished from a human reply", async () => {
  const h = harness({ host: true, own: true }); await h.process(job); assert.equal(h.sent.length, 1);
});
test("uncertain send is recorded UNKNOWN without a retry or leaking provider error", async () => {
  const h = harness({ sendError: true }); await h.process(job);
  assert.equal(h.sent.length, 1); assert.deepEqual(h.outcomes, [{ status: "UNKNOWN", reason: "PIN_AI_PROCESSING_FAILED" }]);
});
test("crashed send is reconciled by host, never generated or replayed", async () => {
  const h = harness(); await h.process({ ...job, status: "SENDING" });
  assert.equal(h.generated.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.outcomes[0].status, "UNKNOWN");
});
test("activation requires exact bounded scope and explicit UTC boundary", () => {
  const env = { PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS: "org", PIN_AI_CHANNEX_AUTO_PROPERTY_IDS: propertyId, PIN_AI_CHANNEX_AUTO_START_AT: "2026-01-01T00:00:00Z" };
  assert.equal(autoConfig(env).allows(job), true); assert.equal(autoConfig({ ...env, PIN_AI_CHANNEX_AUTO_START_AT: "" }).enabled, false);
  assert.equal(autoConfig(env).allows({ ...job, organizationId: "other" }), false); assert.equal(autoConfig({ ...env, PIN_AI_CHANNEX_AUTO_PROPERTY_IDS: "*" }).enabled, false);
});
test("documented webhook identities are validated; body text cannot supply scope or context", () => {
  const body = { event: "message", property_id: propertyId, payload: { id: messageId, property_id: propertyId, message_thread_id: threadId, sender: "guest", message: "untrusted" } };
  assert.deepEqual(parseMessageEvent(body), { externalPropertyId: propertyId, messageId, threadId });
  assert.throws(() => parseMessageEvent({ ...body, property_id: threadId })); assert.equal(parseMessageEvent({ event: "ari" }), null);
  assert.equal(validWebhookSecret("x".repeat(32), "x".repeat(32)), true); assert.equal(validWebhookSecret("x".repeat(32), ["x".repeat(32)]), false); assert.equal(validWebhookSecret("short", "short"), false);
});
