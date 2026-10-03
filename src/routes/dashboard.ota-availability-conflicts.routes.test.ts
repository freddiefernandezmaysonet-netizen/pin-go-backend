import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import { buildAvailabilityConflictReviewRouter } from "./dashboard.ota-availability-conflicts.routes";
import { parseAvailabilityConflictResolution } from "../services/ota-availability-conflict-review.service";

async function harness(t: test.TestContext, role: string | null = "ORG_ADMIN", orgId = "org-a") {
  const prior = process.env.CI; process.env.CI = "true";
  let calls = 0;
  const tx = { dashboardUser: { findFirst: async ({ where }: any) => where.id === "host-a" &&
    where.organizationId === "org-a" && role && where.role.in.includes(role) ? { id: "host-a" } : null },
    reservation: { findFirst: async ({ where }: any) => where.id === "incoming" && where.property.organizationId === "org-a"
      ? { id: "incoming", propertyId: "property-a", status: "CANCELLED", property: { name: "Synthetic", timezone: "America/Puerto_Rico" } } : null },
    operationalIssue: { findMany: async () => [] } };
  const db = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => { calls++; return work(tx); } } as unknown as PrismaClient;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (role !== null) (req as any).user = { id: "host-a", orgId, role }; next(); });
  app.use(buildAvailabilityConflictReviewRouter(db));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (prior === undefined) delete process.env.CI; else process.env.CI = prior; });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard`;
  return { calls: () => calls, get: (id = "incoming") => fetch(`${root}/reservations/${id}/availability-conflicts`),
    resolve: (body: unknown, headers: Record<string, string> = {}) => fetch(`${root}/availability-conflicts/issue-a/resolve`,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }) };
}
const command = { expectedUpdatedAt: "2026-10-02T12:00:00.000Z", resolutionSummary: "Coordinated with the OTA and guests." };
test("real HTTP read is no-store and exposes no technical metadata", async t => {
  const app = await harness(t); const res = await app.get();
  assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual((await res.json()).items, []); assert.equal(app.calls(), 1);
});
test("unauthenticated read and mutation never enter the transaction", async t => {
  const app = await harness(t, null);
  assert.equal((await app.get()).status, 401); assert.equal((await app.resolve(command)).status, 401); assert.equal(app.calls(), 0);
});
for (const role of ["MEMBER", "STAFF"]) test(`role ${role} cannot read conflicts`, async t => {
  const app = await harness(t, role); assert.equal((await app.get()).status, 403);
});
test("platform admin cannot cross tenants; unknown reservation returns 404", async t => {
  const foreign = await harness(t, "PLATFORM_ADMIN", "org-b"); assert.equal((await foreign.get()).status, 403);
  const own = await harness(t); assert.equal((await own.get("missing")).status, 404);
});
test("cookie mutation requires a trusted origin even with bearer header", async t => {
  const app = await harness(t);
  for (const origin of [undefined, "https://untrusted.invalid"]) {
    const res = await app.resolve(command, { Cookie: "pingo_token=synthetic", Authorization: "Bearer synthetic",
      ...(origin ? { Origin: origin } : {}) }); assert.equal(res.status, 403);
  }
  assert.equal(app.calls(), 0);
});
test("malformed closure rejects unknown fields, blank/oversized notes and invalid timestamps", async t => {
  const app = await harness(t);
  for (const value of [null, [], {}, { ...command, organizationId: "org-b" }, { ...command, resolutionSummary: " " },
    { ...command, resolutionSummary: "x".repeat(2001) }, { ...command, expectedUpdatedAt: "invalid" }]) {
    assert.throws(() => parseAvailabilityConflictResolution(value), /INVALID_CONFLICT_RESOLUTION/);
    assert.equal((await app.resolve(value)).status, 400);
  }
  assert.equal(app.calls(), 0);
});
