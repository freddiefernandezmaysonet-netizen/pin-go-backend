import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import { buildAdminStayTimeRecoveryRouter } from "./admin.stay-time-recovery.routes.js";

async function harness(t: test.TestContext, role: string | null = "PLATFORM_ADMIN", active = true) {
  const prior = process.env.CI; process.env.CI = "true"; let calls = 0;
  const db = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => { calls++; return work({
    dashboardUser: { findFirst: async () => active ? { id: "admin-user" } : null },
    operationalIssue: { findMany: async () => [], findFirst: async () => null },
  }); } } as unknown as PrismaClient;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (role) Object.assign(req, { user: { id: "admin-user", orgId: "admin-org", role } }); next(); });
  app.use("/api/internal/stay-time-recovery", buildAdminStayTimeRecoveryRouter(db));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.CI; else process.env.CI = prior; });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/stay-time-recovery`;
  return { calls: () => calls, get: (path = "") => fetch(root + path),
    post: (body: unknown, headers: Record<string, string> = {}) => fetch(root + "/synthetic-issue/reviews", {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }) };
}
const command = { requestId: "synthetic-request", expectedUpdatedAt: "2026-10-03T12:00:00.000Z", note: "Review pending." };
test("HTTP inbox is no-store and allows platform admin", async t => {
  const app = await harness(t); const res = await app.get(); assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store"); assert.deepEqual(await res.json(), { ok: true, items: [], nextCursor: null });
});
for (const role of [null, "ORG_ADMIN", "MEMBER", "STAFF"]) test(`HTTP read and write deny ${role ?? "unauthenticated"}`, async t => {
  const app = await harness(t, role); const expected = role ? 403 : 401;
  assert.equal((await app.get()).status, expected); assert.equal((await app.post(command)).status, expected); assert.equal(app.calls(), 0);
});
test("HTTP rejects revoked admin and unknown incident", async t => {
  const revoked = await harness(t, "PLATFORM_ADMIN", false); assert.equal((await revoked.get()).status, 403);
  const app = await harness(t); assert.equal((await app.get("/unknown-issue")).status, 404);
});
test("ambient cookie mutations require origin even with bearer header", async t => {
  const app = await harness(t);
  const res = await app.post(command, { Cookie: "pingo_token=synthetic", Authorization: "Bearer synthetic" });
  assert.equal(res.status, 403); assert.equal(app.calls(), 0);
});
test("HTTP validation rejects unknown scope and malformed writes", async t => {
  const app = await harness(t); assert.equal((await app.get("?organizationId=other")).status, 400);
  assert.equal((await app.get("?state=garbage")).status, 400);
  assert.equal((await app.post({ ...command, resolved: true })).status, 400); assert.equal(app.calls(), 0);
});
