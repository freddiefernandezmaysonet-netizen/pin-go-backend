import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildDashboardAirbnbHostSelfServiceRouter, type AirbnbHostSelfServiceRouteActions } from "./dashboard.airbnb-host-self-service.route.js";

const user = { id: "host-1", orgId: "org-1", role: "ORG_ADMIN" };
const state = { status: "READY" as const, reason: null, channelId: "channel-1", mappingId: "mapping-1", listingId: "listing-1" };
const result = { outcome: "ACTIVATED" as const, channelActive: true as const, readinessChecked: true };
const body = { ...state, organizationId: "forged-org", requestedByUserId: "forged-user", confirmation: "CONFIRM_AIRBNB_ACTIVATION" };
async function request(options: { method?: string; endpoint?: "activate" | "verify"; user?: typeof user | null; origin?: string | null; key?: string | null; overrides?: Partial<AirbnbHostSelfServiceRouteActions> } = {}) {
  const calls: any[] = [];
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.user = options.user === undefined ? user : options.user; next(); });
  app.use(buildDashboardAirbnbHostSelfServiceRouter({
    enabled: true, isTrustedOrigin: async origin => origin === "https://app.pin-ngo.com",
    issueConnectionLink: async () => { throw new Error("not used"); }, listListings: async () => { throw new Error("not used"); }, verifyCallback: async () => { throw new Error("not used"); },
    inspectActivation: async args => { calls.push(args); return state; },
    activate: async args => { calls.push(args); return result; },
    verifyActivation: async args => { calls.push(args); return { ...result, outcome: "VERIFIED" }; },
    ...options.overrides,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const method = options.method ?? "POST";
  const origin = options.origin === undefined ? "https://app.pin-ngo.com" : options.origin;
  const key = options.key === undefined ? "activation-key-12345678" : options.key;
  try {
    const path = method === "GET" ? "activation" : options.endpoint === "verify" ? "activation/verify" : "activate";
    const requestBody = options.endpoint === "verify" ? { ...body, confirmation: "VERIFY_AIRBNB_ACTIVATION" } : body;
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/distribution/properties/property-1/channels/AIRBNB/${path}`, {
      method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(requestBody) } : {}),
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control"), calls };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("activation route binds tenant/actor to auth and passes only explicit confirmation identity", async () => {
  const r = await request(); assert.equal(r.status, 200); assert.equal(r.cache, "no-store");
  assert.deepEqual(r.body, { ok: true, activation: result });
  assert.deepEqual(r.calls, [{ organizationId: "org-1", propertyId: "property-1", requestedByUserId: "host-1", requestKey: "activation-key-12345678",
    channelId: state.channelId, mappingId: state.mappingId, listingId: state.listingId, confirmation: body.confirmation }]);
});

test("inspection GET exposes no mutation and requires authenticated admin", async () => {
  const r = await request({ method: "GET" }); assert.equal(r.status, 200); assert.equal(r.cache, "no-store");
  assert.deepEqual(r.calls, [{ organizationId: "org-1", propertyId: "property-1" }]);
  assert.deepEqual(r.body, { ok: true, activation: state });
  for (const actor of [null, { ...user, role: "MEMBER" }]) {
    const denied = await request({ method: "GET", user: actor }); assert(denied.status === 401 || denied.status === 403); assert.equal(denied.calls.length, 0);
  }
});

test("verification route is an explicit authenticated action with exact identity", async () => {
  const r = await request({ endpoint: "verify" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, activation: { ...result, outcome: "VERIFIED" } });
  assert.deepEqual(r.calls, [{
    organizationId: "org-1", propertyId: "property-1", requestedByUserId: "host-1", requestKey: "activation-key-12345678",
    channelId: state.channelId, mappingId: state.mappingId, listingId: state.listingId, confirmation: "VERIFY_AIRBNB_ACTIVATION",
  }]);
});

test("activation requires admin, trusted origin, idempotency key and composed runtime", async () => {
  for (const [options, status] of [
    [{ user: null }, 401], [{ user: { ...user, role: "MEMBER" } }, 403],
    [{ origin: null }, 403], [{ origin: "https://evil.test" }, 403], [{ key: null }, 400], [{ key: "bad" }, 400],
    [{ overrides: { enabled: false } }, 503], [{ overrides: { activate: undefined } }, 503],
  ] as const) { const r = await request(options); assert.equal(r.status, status); assert.equal(r.calls.length, 0); }
});

test("conflict and uncertain errors expose safe codes only", async () => {
  for (const [code, status] of [["OTA_AIRBNB_ACTIVATION_CONTEXT_CONFLICT", 409], ["OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED", 503], ["OTA_AIRBNB_ACTIVATION_RATE_LIMITED", 429]] as const) {
    const r = await request({ overrides: { activate: async () => { throw Object.assign(new Error("private provider details"), { code }); } } });
    assert.equal(r.status, status); assert.deepEqual(r.body, { ok: false, error: code });
  }
});

test("verification uses the same mutation security and must be composed", async () => {
  for (const [options, status] of [
    [{ endpoint: "verify", user: null }, 401], [{ endpoint: "verify", user: { ...user, role: "MEMBER" } }, 403],
    [{ endpoint: "verify", origin: "https://evil.test" }, 403], [{ endpoint: "verify", key: null }, 400],
    [{ endpoint: "verify", overrides: { verifyActivation: undefined } }, 503],
  ] as const) {
    const r = await request(options);
    assert.equal(r.status, status);
    assert.equal(r.calls.length, 0);
  }
});
