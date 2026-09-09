import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the entire route module with isolated Express/auth dependencies.
// These tests verify route wiring and its own gates, not authentication internals.
const source = readFileSync(new URL("../routes/dashboard.airbnb-host-self-service.route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}, reportDiagnostics: true });
assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const path = "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/:channelId/listings";
const result = { propertyId: "property-1", channelId: "716305c4-561a-4561-a187-7f5b8aeb5920",
  airbnbAccountVerified: true, listings: [{ id: "42544559", title: "Test Property · Test Channex Property" }], nextAction: "MAPPING_REQUIRED" };
function router({ enabled = true, error = null } = {}) {
  const entries = [], calls = [], exports = {};
  const requireAuth = () => { throw new Error("auth marker is not invoked by handler-only tests"); };
  const mutationSecurity = () => {};
  const routes = { get: (...args) => entries.push({ method: "GET", args }), post: (...args) => entries.push({ method: "POST", args }) };
  const modules = {
    express: { Router: () => routes },
    "../middleware/requireAuth.js": { requireAuth },
    "../distribution/distribution-mutation-security.js": { createDistributionMutationSecurity: () => mutationSecurity },
  };
  runInNewContext(compiled.outputText, { exports, require(name) {
    assert.ok(name in modules); return modules[name];
  } }, { timeout: 1000 });
  exports.buildDashboardAirbnbHostSelfServiceRouter({ enabled, isTrustedOrigin: async () => true,
    async discoverListings(args) { calls.push(JSON.parse(JSON.stringify(args))); if (error) throw error; return result; },
    async issueConnectionLink() { throw new Error("forbidden in discovery"); },
    async verifyCallback() { throw new Error("forbidden in discovery"); },
  });
  const entry = entries.find(e => e.method === "GET" && e.args[0] === path);
  assert.ok(entry, "documented internal discovery route must be registered");
  return { entries, calls, entry, requireAuth, mutationSecurity };
}
async function request(h, user = { id: "user-1", orgId: "org-1", role: "ORG_ADMIN" }) {
  const res = { statusCode: 200, headers: {}, payload: null,
    setHeader(k, v) { this.headers[k] = v; }, status(v) { this.statusCode = v; return this; },
    json(v) { this.payload = JSON.parse(JSON.stringify(v)); return this; } };
  await h.entry.args.at(-1)({ user,
    params: { propertyId: "property-1", channelId: result.channelId },
    body: { organizationId: "attacker-org" }, query: { organizationId: "attacker-org" },
  }, res);
  return res;
}
test("discovery is a GET behind existing requireAuth; no new mutation route", () => {
  const h = router(); assert.equal(h.entry.args[1], h.requireAuth);
  assert.equal(h.entry.args.length, 3);
  assert.equal(h.entries.filter(e => e.method === "POST").length, 2);
  assert.ok(h.entries.filter(e => e.method === "POST").every(e => e.args[1] === h.requireAuth && e.args[2] === h.mutationSecurity));
});
for (const role of ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]) {
  test(`discovery ${role} uses actor tenant, never client-supplied organization`, async () => {
    const h = router(); const res = await request(h, { id: "user-1", orgId: "org-1", role });
    assert.equal(res.statusCode, 200); assert.deepEqual(res.payload, { ok: true, result });
    assert.deepEqual(h.calls, [{ organizationId: "org-1", propertyId: "property-1", channelId: result.channelId }]);
    assert.equal(res.headers["Cache-Control"], "no-store");
  });
}
for (const user of [null, {}, { id: "u", orgId: "o", role: "MEMBER" }, { id: "u", role: "ADMIN" }]) {
  test(`discovery handler refuses missing or non-admin actor ${JSON.stringify(user)}`, async () => {
    const h = router(); const res = await request(h, user);
    assert.equal(res.statusCode, 403); assert.equal(h.calls.length, 0);
  });
}
test("disabled discovery refuses before service/provider access", async () => {
  const h = router({ enabled: false }); const res = await request(h);
  assert.equal(res.statusCode, 503); assert.equal(h.calls.length, 0);
});
for (const [code, status] of [["OTA_AIRBNB_LISTINGS_RESOURCE_NOT_FOUND", 404], ["OTA_AIRBNB_LISTINGS_PROVIDER_FORBIDDEN", 403], ["OTA_AIRBNB_LISTINGS_REQUEST_REJECTED", 422], ["OTA_AIRBNB_LISTINGS_PROVIDER_UNAVAILABLE", 503]]) {
  test(`discovery route preserves safe error ${code}`, async () => {
    const h = router({ error: Object.assign(new Error("SYNTHETIC_PRIVATE_PAYLOAD"), { code }) });
    const res = await request(h); assert.equal(res.statusCode, status);
    assert.deepEqual(res.payload, { ok: false, error: code });
    assert.doesNotMatch(JSON.stringify(res), /SYNTHETIC_PRIVATE_PAYLOAD/);
    assert.equal(h.calls.length, 1);
  });
}
test("unknown discovery errors return only the route fallback", async () => {
  const h = router({ error: new Error("SYNTHETIC_PRIVATE_PAYLOAD") }); const res = await request(h);
  assert.deepEqual(res.payload, { ok: false, error: "OTA_AIRBNB_LISTINGS_DISCOVERY_FAILED" });
});
