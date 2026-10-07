import assert from "node:assert/strict";
import test from "node:test";
import { ensureGlobalMessageWebhook } from "./pin-ai-global-webhook.js";
import { AI_WEBHOOK_HEADER } from "./pin-ai-auto.policy.js";
const callbackUrl = "https://api.example.test/webhooks/ota/channex/messages", secret = "s".repeat(40);
function harness() {
  let row: any = null, claimed = false, posts = 0, lost = false; const verified: string[] = [];
  const input = { callbackUrl, secret, claim: async () => { if (claimed) return false; claimed = true; return true; },
    verified: async (id: string) => { verified.push(id); },
    request: async (method: string, _page?: number, body?: any) => {
      if (method === "GET") return { data: row ? [row] : [], meta: { page: 1, limit: 100, total: row ? 1 : 0 } };
      posts++; row = { id: "webhook-id", attributes: body.webhook, relationships: { property: { data: null } } };
      if (lost) throw Error("provider timeout"); return { data: row };
    } };
  return { input, verified, posts: () => posts, lose: () => { lost = true; }, set: (v: any) => { row = v; } };
}
test("global message subscription is verified and reused without duplicate POST", async () => {
  const h = harness(); assert.deepEqual(await ensureGlobalMessageWebhook(h.input), { id: "webhook-id", created: true });
  assert.deepEqual(await ensureGlobalMessageWebhook(h.input), { id: "webhook-id", created: false });
  assert.equal(h.posts(), 1); assert.deepEqual(h.verified, ["webhook-id", "webhook-id"]);
});
test("lost registration response reconciles only by reading existing subscription", async () => {
  const h = harness(); h.lose(); await assert.rejects(ensureGlobalMessageWebhook(h.input), /timeout/);
  assert.equal((await ensureGlobalMessageWebhook(h.input)).created, false); assert.equal(h.posts(), 1);
});
test("uncertain attempt without visible evidence never creates a second subscription", async () => {
  const h = harness(); h.lose(); await assert.rejects(ensureGlobalMessageWebhook(h.input)); h.set(null);
  await assert.rejects(ensureGlobalMessageWebhook(h.input), /RECONCILIATION_REQUIRED/); assert.equal(h.posts(), 1);
});
test("existing wrong secret, inactive or broad event subscription is blocked", async () => {
  for (const patch of [{ is_active: false }, { event_mask: "*" }, { headers: { [AI_WEBHOOK_HEADER]: "other" } }]) {
    const h = harness(); h.set({ id: "existing", attributes: { callback_url: callbackUrl, is_global: true,
      event_mask: "message", is_active: true, send_data: true, headers: { [AI_WEBHOOK_HEADER]: secret }, ...patch } });
    await assert.rejects(ensureGlobalMessageWebhook(h.input), /CONFLICT/); assert.equal(h.posts(), 0);
  }
});
