import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

// Disposable loopback fixtures only; no real database or notifications.
test("native incident boundary enforces sessions, preserves web Origin and scopes receipts", async t => {
  process.env.JWT_SECRET = "synthetic-incident-session-secret-not-production";
  const { buildHostIncidentRouter } = await import("../../routes/dashboard.pin-ai-host-incidents.routes.js");
  const { signSessionBoundAuthToken } = await import("../../auth/session-bound-token.js");
  let revoked = false, unavailable = false;
  const users: Record<string, string> = { host: "organization-1", colleague: "organization-1", foreign: "organization-2" };
  const issue = { workflowState: "ACTION_REQUIRED", issue: "Synthetic report", id: "issue", propertyId: "property", reservationId: "reservation", metadata: { reference: "GI-A12345678901" } };
  const tx: any = {
    dashboardUser: {
      findUnique: async ({ where }: any) => {
        if (unavailable) throw Error("synthetic unavailable");
        return { id: where.id, organizationId: users[where.id], role: "ORG_ADMIN", email: "host@example.invalid", isActive: true, tokenVersion: 1, organization: null };
      },
      findFirst: async ({ where }: any) => users[where.id] === where.organizationId ? { id: where.id } : null,
    },
    authSession: { findUnique: async ({ where }: any) => ({ id: where.id, userId: where.id.replace("session-", ""), organizationId: users[where.id.replace("session-", "")], tokenVersion: 1,
      authenticatedAt: new Date(), lastActivityAt: new Date(), absoluteExpiresAt: new Date(Date.now() + 60000), revokedAt: revoked ? new Date() : null }) },
    operationalIssue: { findFirst: async ({ where }: any) => where.organizationId === "organization-1" && where.metadata.equals === issue.metadata.reference ? issue : null },
    property: { findFirst: async () => null },
    reservation: { findFirst: async () => ({ reservationNumber: "TEST-ONLY", property: { name: "Synthetic" } }) },
    pinAIHostIncidentThread: { findUnique: async () => ({ id: "thread", version: 0, acknowledgedAt: null, organizationId: "organization-1", propertyId: "property", reservationId: "reservation" }) },
    pinAIHostIncidentMessage: { findMany: async () => [], findFirst: async ({ where, select }: any) => {
      assert.deepEqual(select, { id: true, sequence: true, kind: true });
      assert.equal(where.threadId, "thread");
      return where.actorId === "host" && where.requestId === "request-123456789" ? { id: "event", sequence: 1, kind: "NOTE" } : null;
    } },
  };
  tx.$transaction = async (run: any) => run(tx);
  const env = { PIN_AI_HOST_INCIDENT_ENABLED: "true", PIN_AI_HOST_INCIDENT_ORGANIZATION_IDS: "organization-1", PIN_AI_HOST_INCIDENT_RESERVATION_IDS: "reservation" };
  const app = express(); app.use(express.json()); app.use(buildHostIncidentRouter({ prisma: tx, env }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(e => e ? reject(e) : resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = (id = "host", sid: string | undefined = `session-${id}`) => signSessionBoundAuthToken({ sub: id, orgId: users[id]!, tokenVersion: 1, email: "host@example.invalid", role: "ORG_ADMIN" }, sid);
  const path = "/api/host-mobile/pin-ai/incidents/GI-A12345678901";
  async function get(suffix = "/receipts/request-123456789", headers: Record<string,string> = { Authorization: `Bearer ${token()}` }) {
    const r = await fetch(base + path + suffix, { headers }); return { status: r.status, body: await r.json() };
  }
  assert.equal((await get("/receipts/request-123456789", {})).status, 401);
  assert.equal((await get("/receipts/request-123456789", { Authorization: "Bearer invalid" })).status, 401);
  for (const extra of ([{ Origin: "https://app.pin-ngo.com" }, { Cookie: "session=synthetic" }] as Record<string,string>[]))
    assert.equal((await get("/receipts/request-123456789", { Authorization: `Bearer ${token()}`, ...extra })).status, 403);
  assert.deepEqual((await get("")).body.mobileActions, ["NOTE", "ACKNOWLEDGE", "PUBLISH", "RESOLVE"]);
  assert.deepEqual((await get()).body, { ok: true, reference: "GI-A12345678901", requestId: "request-123456789", status: "ACCEPTED", eventId: "event", version: 1, operation: "NOTE" });
  assert.equal((await get("/receipts/request-missing-123")).body.status, "UNCONFIRMED");
  assert.equal((await get("/receipts/request-123456789", { Authorization: `Bearer ${token("colleague")}` })).body.status, "UNCONFIRMED");
  assert.equal((await get("/receipts/request-123456789", { Authorization: `Bearer ${token("foreign")}` })).status, 404);
  const invalid = await fetch(base + path + "/actions", { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "UNLOCK" }) });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, "INVALID_REQUEST");
  revoked = true; assert.equal((await get()).status, 401); revoked = false;
  unavailable = true; assert.equal((await get()).status, 503); unavailable = false;
  const { prisma: shared } = await import("../../lib/prisma.js");
  const oldUser = shared.dashboardUser.findUnique, oldSession = shared.authSession.findUnique;
  shared.dashboardUser.findUnique = tx.dashboardUser.findUnique;
  shared.authSession.findUnique = tx.authSession.findUnique;
  t.after(() => { shared.dashboardUser.findUnique = oldUser; shared.authSession.findUnique = oldSession; });
  const { getAuthCookieName } = await import("../../lib/auth.js");
  const web = await fetch(base + "/api/dashboard/pin-ai/incidents/GI-A12345678901/actions", { method: "POST", body: "{}", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Cookie: `${getAuthCookieName()}=synthetic` } });
  assert.equal(web.status, 403);
});
