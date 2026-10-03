import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildDashboardChannexHostInboxRouter } from "./dashboard.channex-host-inbox.route.js";

async function call(options: { role?: string; auth?: boolean; disabled?: boolean; method?: string; path?: string; origin?: string; body?: unknown; key?: string; trust?: boolean } = {}) {
  const calls: unknown[] = [];
  const runtime = {
    async properties(org: string) { calls.push(org); return { items: [] }; },
    async list(scope: unknown, page: unknown) { calls.push({ scope, page }); return { items: [] }; },
    async messages(scope: unknown) { calls.push(scope); return { items: [] }; },
    async reply(input: unknown) { calls.push(input); return { message: {} }; },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (options.auth !== false) (req as any).user = { id: "host-a", orgId: "org-a", role: options.role ?? "ORG_ADMIN" }; next(); });
  app.use(buildDashboardChannexHostInboxRouter({ runtime: options.disabled ? null : runtime as any, isTrustedOrigin: async (origin, org) => options.trust !== false && origin === "https://app.pin-ngo.com" && org === "org-a" }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/channex-messages${options.path ?? "/properties"}`, {
      method: options.method ?? "GET", headers: { "Content-Type": "application/json", "Connection": "close", ...(options.origin ? { origin: options.origin } : {}), ...(options.key ? { "idempotency-key": options.key } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control"), calls };
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test("rejects unauthenticated, unauthorized and disabled requests before runtime access", async () => {
  for (const [options, status] of [[{ auth: false }, 401], [{ role: "STAFF" }, 403], [{ disabled: true }, 503]] as const) {
    const result = await call(options); assert.equal(result.status, status); assert.equal(result.calls.length, 0);
  }
});
test("uses only authenticated organization, ignoring organization overrides", async () => {
  const result = await call({ path: "/properties/local/threads?organizationId=other&page=2&limit=25" });
  assert.equal(result.status, 200); assert.equal(result.cache, "no-store");
  assert.deepEqual(result.calls[0], { scope: { organizationId: "org-a", propertyId: "local" }, page: { page: 2, limit: 25 } });
});
test("strict query parsing rejects arrays and malformed numbers", async () => {
  for (const query of ["page=1&page=2", "page=1.5", "page=0", "limit=abc"]) {
    const result = await call({ path: `/properties/local/threads?${query}` }); assert.equal(result.status, 400); assert.equal(result.calls.length, 0);
  }
});
test("reply requires an exact trusted Origin and rejects extra body fields", async () => {
  for (const change of [{}, { origin: "https://evil.invalid" }, { origin: "https://app.pin-ngo.com/path" }, { origin: "https://app.pin-ngo.com", trust: false }, { origin: "https://app.pin-ngo.com", body: { text: "Hola", organizationId: "other" } }]) {
    const result = await call({ method: "POST", path: "/properties/local/threads/thread/messages", key: "key-123456", body: { text: "Hola" }, ...change });
    assert.ok([400, 403].includes(result.status)); assert.equal(result.calls.length, 0);
  }
});
test("reply passes authenticated actor, destination and request key to service", async () => {
  const result = await call({ method: "POST", path: "/properties/local/threads/thread/messages", key: "key-123456", origin: "https://app.pin-ngo.com", body: { text: "Hola" } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls[0], { organizationId: "org-a", propertyId: "local", threadId: "thread", requestedBy: "host-a", text: "Hola", requestKey: "key-123456" });
});
