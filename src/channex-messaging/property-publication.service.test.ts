import assert from "node:assert/strict";
import test from "node:test";
import { ensureMessagesApplication } from "./application-installation.js";
import { ensurePublishedPropertyMessages, createMessagesApplicationRequest,
  createPropertyMessagesInstaller, type PublicationDependencies } from "./property-publication.service.js";

const installation = { id: "installation-a", attributes: {
  property_id: "remote-a", application_code: "channex_messages", is_active: true,
} };
function fixture() {
  const calls: string[] = [];
  let installed = false, locked = false, rejectInstall = false;
  const dependencies: PublicationDependencies = {
    async withPropertyLock(_scope, work) {
      if (locked) throw new Error("PUBLICATION_BUSY");
      locked = true;
      try { return await work(); } finally { locked = false; }
    },
    async resolveMapping(scope) {
      calls.push("mapping");
      if (scope.organizationId !== "org-a") throw new Error("MAPPING_NOT_READY");
      return "remote-a";
    },
    createRequest() {
      calls.push("transport");
      return async input => {
        calls.push(input.method);
        if (input.method === "POST") {
          if (rejectInstall) throw new Error("PROVIDER_UNAVAILABLE");
          installed = true; return {};
        }
        return { data: installed ? [installation] : [] };
      };
    },
  };
  return { dependencies, calls, setRejectInstall: (value: boolean) => { rejectInstall = value; } };
}
const scope = { propertyId: "property-a", organizationId: "org-a" };

test("installation resolves canonical scoped mapping before creating transport", async () => {
  const f = fixture();
  const result = await ensurePublishedPropertyMessages(scope, f.dependencies);
  assert.equal(result.installationId, "installation-a");
  assert.deepEqual(f.calls, ["mapping", "transport", "GET", "POST", "GET"]);
});

test("another organization cannot call Channex", async () => {
  const f = fixture();
  await assert.rejects(ensurePublishedPropertyMessages({ ...scope, organizationId: "org-b" }, f.dependencies), /NOT_READY/);
  assert.deepEqual(f.calls, ["mapping"]);
});

test("installation failure propagates; retries and repeated preparation reconcile first", async () => {
  const f = fixture(); f.setRejectInstall(true);
  await assert.rejects(ensurePublishedPropertyMessages(scope, f.dependencies), /UNAVAILABLE/);
  f.setRejectInstall(false);
  assert.equal((await ensurePublishedPropertyMessages(scope, f.dependencies)).alreadyInstalled, false);
  assert.equal((await ensurePublishedPropertyMessages(scope, f.dependencies)).alreadyInstalled, true);
  assert.equal(f.calls.filter(c => c === "POST").length, 2); // One rejected, one accepted.
});

test("concurrent calls cannot both enter installation flow", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    ensurePublishedPropertyMessages(scope, f.dependencies),
    ensurePublishedPropertyMessages(scope, f.dependencies),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal(f.calls.filter(c => c === "POST").length, 1);
});

test("real installer uses tenant-scoped READY inventory and a distributed lock", async () => {
  let query: any, lockQuery = "", fetched = 0;
  const prisma = {
    distributionProperty: { async findFirst(input: unknown) { query = input; return {
      externalPropertyId: "remote-a", group: { organizationId: "org-a", provisioningStatus: "READY", externalGroupId: "group-a" },
    }; } },
    async $transaction(work: (tx: unknown) => Promise<unknown>, options: unknown) {
      assert.deepEqual(options, { maxWait: 5000, timeout: 90000 });
      return work({ async $queryRaw(parts: TemplateStringsArray, key: string) {
        lockQuery = parts.join("?"); assert.equal(key, "channex-messages-publication:property-a");
        return [{ locked: true }];
      } });
    },
  };
  const install = createPropertyMessagesInstaller({ prisma: prisma as any,
    apiOrigin: "https://staging.channex.io", apiKey: "synthetic-key",
    fetchImpl: async () => { fetched++; return Response.json({ data: [installation] }); } });
  await install(scope);
  assert.deepEqual(query.where, { organizationId: "org-a", propertyId: "property-a", platform: "CHANNEX",
    provisioningStatus: "READY", property: { organizationId: "org-a", status: "ACTIVE" } });
  assert.match(lockQuery, /pg_try_advisory_xact_lock/);
  assert.equal(fetched, 1);
});

test("lock rejection performs no mapping reads or provider calls", async () => {
  const prisma = { async $transaction(work: (tx: unknown) => Promise<unknown>) {
    return work({ $queryRaw: async () => [{ locked: false }] });
  } };
  const install = createPropertyMessagesInstaller({ prisma: prisma as any,
    apiOrigin: "https://staging.channex.io", apiKey: "synthetic-key",
    fetchImpl: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(install(scope), /INSTALLATION_BUSY/);
});

test("transport sends authenticated documented endpoints and never follows redirects", async () => {
  const request = createMessagesApplicationRequest({ apiOrigin: "https://app.channex.io", apiKey: "synthetic-key",
    fetchImpl: async (url, init) => {
      assert.equal(new URL(String(url)).origin, "https://app.channex.io");
      assert.equal(new URL(String(url)).searchParams.get("pagination[page]"), "1");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>)["user-api-key"], "synthetic-key");
      return Response.json({ data: [installation] });
    } });
  const result = await ensureMessagesApplication("remote-a", request);
  assert.equal(result.alreadyInstalled, true);
});

test("transport sanitizes provider and network failures", async () => {
  for (const response of [new Response("secret provider body", { status: 403 }), null]) {
    const request = createMessagesApplicationRequest({ apiOrigin: "https://staging.channex.io", apiKey: "synthetic-key",
      fetchImpl: async () => { if (response) return response; throw new Error("synthetic-key secret"); } });
    await assert.rejects(request({ method: "GET", path: "/api/v1/applications/installed" }),
      response ? /OTA_MESSAGES_API_HTTP_403/ : /OTA_MESSAGES_API_OUTCOME_UNKNOWN/);
  }
});

test("transport forbids untrusted origins and arbitrary endpoints", async () => {
  assert.throws(() => createMessagesApplicationRequest({ apiOrigin: "https://example.com", apiKey: "key" }), /CONFIGURATION_INVALID/);
  const request = createMessagesApplicationRequest({ apiOrigin: "https://staging.channex.io", apiKey: "key",
    fetchImpl: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(request({ method: "POST", path: "/api/v1/properties" }), /REQUEST_NOT_ALLOWED/);
});
