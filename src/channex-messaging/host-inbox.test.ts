import assert from "node:assert/strict";
import test from "node:test";
import { createHostInbox, createInboxHttpRequest, type InboxDependencies, type Receipt } from "./host-inbox.js";

const property = "11111111-1111-4111-8111-111111111111", thread = "22222222-2222-4222-8222-222222222222", message = "33333333-3333-4333-8333-333333333333";
const scope = { organizationId: "org-a", propertyId: "local-property" };
const reply = { ...scope, threadId: thread, text: "Hola", requestedBy: "host-a", requestKey: "request-123" };
const rel = (type: string, id: string) => ({ data: { type, id } });
const attrs = { message: "Hola", sender: "property", attachments: [], inserted_at: "2026-10-03T01:00:00.000000" };
function remoteThread(overrides = {}) {
  return { id: thread, type: "message_thread", attributes: { title: "Huésped", provider: "AirBNB", is_closed: false, message_count: 1, last_message: attrs, updated_at: attrs.inserted_at, ...overrides }, relationships: { property: rel("property", property) } };
}
const remoteMessage = () => ({ id: message, type: "message", attributes: attrs, relationships: { message_thread: rel("message_thread", thread) } });
function fixture(overrides: Partial<InboxDependencies> = {}) {
  const requests: Parameters<InboxDependencies["request"]>[0][] = [];
  const receipts = new Map<string, Receipt>();
  const deps: InboxDependencies = {
    async resolveProperty(actual) { assert.equal(actual.organizationId, scope.organizationId); return property; },
    async request(input) {
      requests.push(input);
      if (input.method === "POST") return { data: remoteMessage() };
      if (input.path.endsWith("/messages")) return { data: [remoteMessage()], meta: { page: 1, limit: 25, total: 1 } };
      if (input.path.endsWith(thread)) return { data: remoteThread() };
      return { data: [remoteThread()], meta: { page: 1, limit: 25, total: 1 } };
    },
    async reserve(input) {
      const prior = receipts.get(input.requestKey);
      if (prior) return { fresh: false, receipt: prior };
      const receipt = { fingerprint: input.fingerprint, status: "PENDING", response: null };
      receipts.set(input.requestKey, receipt); return { fresh: true, receipt };
    },
    async complete(_org, key, response) { Object.assign(receipts.get(key)!, { status: "SENT", response }); },
    async unknown(_org, key) { receipts.get(key)!.status = "UNKNOWN"; },
    ...overrides,
  };
  return { inbox: createHostInbox(deps), deps, requests, receipts };
}
test("lists only mapped property threads with pagination and permits inquiries without a booking", async () => {
  const { inbox, requests } = fixture();
  const result = await inbox.list(scope, { page: 1, limit: 25 });
  assert.equal(result.items[0]?.bookingId, null);
  assert.equal(requests[0]?.query?.["filter[property_id]"], property);
  assert.equal(result.items[0]?.lastMessage?.insertedAt, `${attrs.inserted_at}Z`);
});
test("checks thread property before reading messages", async () => {
  let calls = 0;
  const { inbox } = fixture({ request: async () => { calls++; return { data: { ...remoteThread(), relationships: { property: rel("property", "99999999-9999-4999-8999-999999999999") } } }; } });
  await assert.rejects(inbox.messages(scope, thread, { page: 1, limit: 25 }), /THREAD_NOT_FOUND/);
  assert.equal(calls, 1);
});
test("checks property mapping before any provider request", async () => {
  let calls = 0;
  const { inbox } = fixture({ resolveProperty: async () => { throw new Error("denied"); }, request: async () => { calls++; return {}; } });
  await assert.rejects(inbox.reply(reply), /denied/); assert.equal(calls, 0);
});
test("sends exact documented payload and replays a successful receipt without a second POST", async () => {
  const { inbox, requests } = fixture();
  assert.equal((await inbox.reply(reply)).replayed, false);
  assert.equal((await inbox.reply(reply)).replayed, true);
  const posts = requests.filter(x => x.method === "POST");
  assert.equal(posts.length, 1); assert.deepEqual(posts[0]?.body, { message: { message: "Hola" } });
});
test("concurrent submissions with the same key reserve only one send", async () => {
  const { inbox, requests } = fixture();
  const results = await Promise.allSettled([inbox.reply(reply), inbox.reply(reply)]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(requests.filter(x => x.method === "POST").length, 1);
});
test("key conflicts reject changed text, actor or destination", async () => {
  const { inbox, requests } = fixture(); await inbox.reply(reply);
  for (const changed of [{ text: "otro" }, { requestedBy: "another-host" }, { propertyId: "another-property" }]) await assert.rejects(inbox.reply({ ...reply, ...changed }), /REQUEST_KEY_CONFLICT/);
  assert.equal(requests.filter(x => x.method === "POST").length, 1);
});
test("unknown POST outcome remains blocked across service reconstruction", async () => {
  const f = fixture(); const original = f.deps.request;
  f.deps.request = async input => { if (input.method === "POST") throw new Error("secret network data"); return original(input); };
  await assert.rejects(f.inbox.reply(reply), /SEND_OUTCOME_UNKNOWN/);
  assert.equal(f.receipts.get(reply.requestKey)?.status, "UNKNOWN");
  await assert.rejects(createHostInbox(f.deps).reply(reply), /SEND_OUTCOME_UNKNOWN/);
});
test("failed receipt persistence cannot cause a second send", async () => {
  const f = fixture({ complete: async () => { throw new Error("database down"); }, unknown: async () => { throw new Error("database down"); } });
  await assert.rejects(f.inbox.reply(reply), /SEND_OUTCOME_UNKNOWN/);
  assert.equal(f.receipts.get(reply.requestKey)?.status, "PENDING");
  await assert.rejects(f.inbox.reply(reply), /SEND_OUTCOME_UNKNOWN/);
  assert.equal(f.requests.filter(x => x.method === "POST").length, 1);
});
test("closed and unsupported threads never send", async () => {
  for (const attributes of [{ is_closed: true }, { provider: "Vrbo" }]) {
    const f = fixture({ request: async () => ({ data: remoteThread(attributes) }) });
    await assert.rejects(f.inbox.reply(reply), /THREAD_CLOSED|PROVIDER_UNSUPPORTED/);
    assert.equal(f.receipts.size, 0);
  }
});
test("rejects invalid pagination, identifier and reply before provider access", async () => {
  const f = fixture();
  for (const p of [{ page: 0, limit: 25 }, { page: 1, limit: 101 }, { page: 1.2, limit: 25 }]) await assert.rejects(f.inbox.list(scope, p), /PAGE_INVALID/);
  await assert.rejects(f.inbox.messages(scope, "../properties", { page: 1, limit: 25 }), /THREAD_INVALID/);
  for (const input of [{ text: " " }, { text: "x".repeat(5001) }, { requestKey: "bad" }]) await assert.rejects(f.inbox.reply({ ...reply, ...input }), /REPLY_INVALID/);
  assert.equal(f.requests.length, 0);
});
test("fails closed for unscoped lists, duplicate data and invalid metadata", async () => {
  for (const data of [
    { data: [{ ...remoteThread(), relationships: {} }], meta: { page: 1, limit: 25, total: 1 } },
    { data: [remoteThread(), remoteThread()], meta: { page: 1, limit: 25, total: 2 } },
    { data: [remoteThread()], meta: { page: 2, limit: 25, total: 1 } },
  ]) {
    const f = fixture({ request: async () => data });
    await assert.rejects(f.inbox.list(scope, { page: 1, limit: 25 }), /RESPONSE_INVALID/);
  }
});
test("rejects mismatched message relationships and unknown senders", async () => {
  for (const data of [
    { ...remoteMessage(), relationships: { message_thread: rel("message_thread", property) } },
    { ...remoteMessage(), attributes: { ...attrs, sender: "unknown" } },
  ]) {
    const f = fixture(); const original = f.deps.request;
    f.deps.request = async input => input.path.endsWith("/messages") ? { data: [data], meta: { page: 1, limit: 25, total: 1 } } : original(input);
    await assert.rejects(f.inbox.messages(scope, thread, { page: 1, limit: 25 }), /RESPONSE_INVALID/);
  }
});
test("HTTP transport bounds origin, paths, time, redirects and response size", async () => {
  assert.throws(() => createInboxHttpRequest({ apiOrigin: "https://evil.invalid", apiKey: "secret" }), /CONFIGURATION_INVALID/);
  const calls: RequestInit[] = [];
  const request = createInboxHttpRequest({ apiOrigin: "https://staging.channex.io", apiKey: "secret", fetchImpl: async (_url, init) => { calls.push(init!); return new Response(JSON.stringify({ data: [] })); } });
  await assert.rejects(request({ method: "POST", path: "/api/v1/applications/install" }), /REQUEST_INVALID/);
  await request({ method: "GET", path: "/api/v1/message_threads" });
  assert.equal(calls[0]?.redirect, "error"); assert.ok(calls[0]?.signal);
  const large = createInboxHttpRequest({ apiOrigin: "https://app.channex.io", apiKey: "secret", fetchImpl: async () => new Response("x".repeat(1_000_001)) });
  await assert.rejects(large({ method: "GET", path: "/api/v1/message_threads" }), /RESPONSE_LIMIT/);
});
test("HTTP transport exposes only sanitized provider errors", async () => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const request = createInboxHttpRequest({ apiOrigin: "https://app.channex.io", apiKey: "secret", fetchImpl: async () => new Response("credentials guest body", { status }) });
    await assert.rejects(request({ method: "GET", path: "/api/v1/message_threads" }), error => error instanceof Error && !/credentials|guest body|secret/.test(error.message));
  }
});
