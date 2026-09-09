import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../routes/dashboard.airbnb-host-self-service.route.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(
  (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length,
  0
);

const PATH =
  "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/:channelId/mapping-plan";
const PLAN = {
  propertyId: "property-1",
  channelId: "716305c4-561a-4561-a187-7f5b8aeb5920",
  listing: { id: "42544559", title: "Test Property · Test Channex Property" },
  ratePlan: {
    id: "7e9409b4-160b-4412-941f-09c2c205b13b",
    source: "PIN_GO_PRIMARY_RATE_PLAN",
  },
  mappingRequest: {
    mapping: {
      rate_plan_id: "7e9409b4-160b-4412-941f-09c2c205b13b",
      settings: { listing_id: "42544559" },
    },
  },
  executable: false,
  nextAction: "MAPPING_EXECUTION_REQUIRES_APPROVAL",
};

function harness({ enabled = true, error = null } = {}) {
  const entries = [];
  const calls = [];
  const exports = {};
  const requireAuth = () => {};
  const mutationSecurity = () => {};
  const routes = {
    get: (...args) => entries.push({ method: "GET", args }),
    post: (...args) => entries.push({ method: "POST", args }),
  };
  const modules = {
    express: { Router: () => routes },
    "../middleware/requireAuth.js": { requireAuth },
    "../distribution/distribution-mutation-security.js": {
      createDistributionMutationSecurity: () => mutationSecurity,
    },
  };
  runInNewContext(
    compiled.outputText,
    {
      exports,
      require(name) {
        assert.ok(name in modules, `unexpected module ${name}`);
        return modules[name];
      },
    },
    { timeout: 1000 }
  );
  exports.buildDashboardAirbnbHostSelfServiceRouter({
    enabled,
    isTrustedOrigin: async () => true,
    async prepareMappingPlan(args) {
      calls.push(JSON.parse(JSON.stringify(args)));
      if (error) throw error;
      return PLAN;
    },
    async discoverListings() {
      throw new Error("not used in mapping preflight route");
    },
    async issueConnectionLink() {
      throw new Error("not used in mapping preflight route");
    },
    async verifyCallback() {
      throw new Error("not used in mapping preflight route");
    },
  });
  const entry = entries.find(
    (candidate) => candidate.method === "GET" && candidate.args[0] === PATH
  );
  assert.ok(entry);
  return { entries, calls, entry, requireAuth, mutationSecurity };
}

async function request(
  h,
  user = { id: "user-1", orgId: "org-1", role: "ORG_ADMIN" },
  listingId = "42544559"
) {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.payload = JSON.parse(JSON.stringify(value));
      return this;
    },
  };
  await h.entry.args.at(-1)(
    {
      user,
      params: { propertyId: "property-1", channelId: PLAN.channelId },
      query: { listingId, organizationId: "attacker-org" },
      body: { listingId: "attacker-listing", organizationId: "attacker-org" },
    },
    res
  );
  return res;
}

test("mapping preflight is GET-only behind requireAuth and creates no mapping route", () => {
  const h = harness();
  assert.equal(h.entry.args[1], h.requireAuth);
  assert.equal(h.entry.args.length, 3);
  assert.equal(h.entries.filter((entry) => entry.method === "POST").length, 2);
  assert.ok(
    h.entries.every(
      (entry) =>
        entry.method !== "POST" || !String(entry.args[0]).includes("mapping")
    )
  );
});

for (const role of ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]) {
  test(`mapping preflight ${role} uses actor tenant and explicit query listing`, async () => {
    const h = harness();
    const res = await request(h, { id: "user-1", orgId: "org-1", role });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { ok: true, result: PLAN });
    assert.deepEqual(h.calls, [
      {
        organizationId: "org-1",
        propertyId: "property-1",
        channelId: PLAN.channelId,
        listingId: "42544559",
      },
    ]);
    assert.equal(res.headers["Cache-Control"], "no-store");
  });
}

for (const user of [
  null,
  {},
  { id: "u", orgId: "o", role: "MEMBER" },
  { id: "u", role: "ADMIN" },
]) {
  test(`mapping preflight refuses missing/non-admin actor ${JSON.stringify(user)}`, async () => {
    const h = harness();
    const res = await request(h, user);
    assert.equal(res.statusCode, 403);
    assert.equal(h.calls.length, 0);
  });
}

test("mapping preflight does not take listing id from request body", async () => {
  const h = harness();
  await request(h, undefined, "fresh-provider-listing");
  assert.equal(h.calls[0].listingId, "fresh-provider-listing");
});

test("mapping plan errors are sanitized by existing safe error boundary", async () => {
  const h = harness({
    error: Object.assign(new Error("SYNTHETIC_PRIVATE_PAYLOAD"), {
      code: "OTA_AIRBNB_MAPPING_LISTING_NOT_FOUND",
    }),
  });
  const res = await request(h);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.payload, {
    ok: false,
    error: "OTA_AIRBNB_MAPPING_LISTING_NOT_FOUND",
  });
  assert.doesNotMatch(JSON.stringify(res), /SYNTHETIC_PRIVATE_PAYLOAD/);
});
