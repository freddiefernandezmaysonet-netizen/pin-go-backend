import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import { PIN_AI_BILLING_TERMS } from "../pin-ai/billing-terms.js";
import { buildPinAIActivationRouter } from "./dashboard.pin-ai-activation.routes.js";

async function harness(t: test.TestContext, role = "ORG_ADMIN", actorOrg = "org-a", active = true) {
  const old = process.env.CI; process.env.CI = "true";
  t.after(() => { if (old === undefined) delete process.env.CI; else process.env.CI = old; });
  const organization = { id: "org-a", name: "Synthetic", pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_host" };
  const property = { id: "property-a", name: "Synthetic", organizationId: "org-a", status: "ACTIVE", pinAIEnabled: false, pinAIRevision: 0, organization, pinAITermsVersion: null, pinAITermsAcceptedAt: null, pinAITermsAcceptedBy: null };
  const events: unknown[] = [];
  const tx = {
    dashboardUser: { findFirst: async ({ where }: any) => active && where.id === "host-a" && where.organizationId === actorOrg && where.role.in.includes(role) ? { id: "host-a" } : null },
    property: {
      findFirst: async ({ where }: any) => where.id === property.id && where.organizationId === property.organizationId ? structuredClone(property) : null,
      updateMany: async ({ where, data }: any) => { if (where.pinAIRevision !== property.pinAIRevision) return { count: 0 };
        Object.assign(property, { pinAITermsVersion: data.pinAITermsVersion ?? property.pinAITermsVersion, pinAITermsAcceptedAt: data.pinAITermsAcceptedAt ?? property.pinAITermsAcceptedAt, pinAITermsAcceptedBy: data.pinAITermsAcceptedBy ?? property.pinAITermsAcceptedBy }); property.pinAIEnabled = data.pinAIEnabled; property.pinAIRevision++; return { count: 1 }; },
    },
    organization: {
      findMany: async () => [structuredClone(organization)],
      updateMany: async ({ where, data }: any) => { if (where.id !== organization.id || where.pinAIRevision !== organization.pinAIRevision) return { count: 0 };
        organization.pinAIEnabled = data.pinAIEnabled; organization.pinAIRevision++; return { count: 1 }; },
    },
    apmsAuditEntry: { create: async ({ data }: any) => { events.push(data); return data; } },
  };
  const db = { $transaction: async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (role) Object.assign(req, { user: { id: "host-a", orgId: actorOrg, role } }); next(); });
  let compatible = true, unavailable = false, reads = 0;
  let afterCheck = () => {};
  app.use(buildPinAIActivationRouter(db, {}, { eligibility: async accountId => {
    reads++; assert.equal(accountId, "acct_host");
    if (unavailable) throw Error("Stripe unavailable");
    afterCheck(); return { compatible, availableCents: 0 };
  } }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown) => fetch(url + path, body === undefined ? {} :
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { request, property, organization, events,
    setCompatibility: (value: boolean) => { compatible = value; },
    setUnavailable: () => { unavailable = true; },
    setAfterCheck: (fn: () => void) => { afterCheck = fn; },
    reads: () => reads };
}
const path = "/api/dashboard/properties/property-a/pin-ai-settings";
const update = { enabled: true, expectedRevision: 0, organizationRevision: 1, acceptedTermsVersion: PIN_AI_BILLING_TERMS.version };

for (const [role, active, status] of [["", true, 401], ["MEMBER", true, 403], ["ORG_ADMIN", false, 403]] as const) {
  test(`activation rejects missing/revoked authority: ${role || "unauthenticated"}/${active}`, async t => {
    const h = await harness(t, role, "org-a", active);
    assert.equal((await h.request(path)).status, status);
    assert.equal((await h.request(path, update)).status, status);
    assert.equal(h.events.length, 0);
  });
}
test("another organization cannot read or change a property, including a platform admin", async t => {
  const h = await harness(t, "PLATFORM_ADMIN", "org-other");
  assert.equal((await h.request(path)).status, 404);
  assert.equal((await h.request(path, update)).status, 404);
  assert.equal(h.events.length, 0);
});
test("organization entitlement cannot be self-granted by a host", async t => {
  const h = await harness(t);
  assert.equal((await h.request("/api/internal/pin-ai/organizations")).status, 403);
  assert.equal((await h.request("/api/internal/pin-ai/organizations/org-a", { enabled: true, expectedRevision: 1 })).status, 403);
  assert.equal(h.events.length, 0);
});
test("property setting round-trips with audit, remains pending release and rejects stale writes", async t => {
  const h = await harness(t);
  const response = await h.request(path, update);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.enabled, true); assert.equal(data.state, "PENDING_ACTIVATION");
  assert.equal(data.capabilities.reservationActions, "CONTROLLED_RELEASE");
  assert.equal(data.capabilities.channelReplies, "SEPARATE_ACTIVATION");
  assert.equal((await (await h.request(path)).json()).revision, 1);
  assert.equal((await h.request(path, update)).status, 409);
  assert.equal(h.events.length, 1);
});
test("host cannot activate a revoked entitlement or overwrite a changed organization", async t => {
  const h = await harness(t);
  h.organization.pinAIEnabled = false;
  assert.equal((await h.request(path, update)).status, 403);
  h.organization.pinAIRevision++;
  assert.equal((await h.request(path, update)).status, 409);
  assert.equal(h.events.length, 0);
});
test("unknown fields cannot widen activation to paid actions or another property", async t => {
  const h = await harness(t);
  for (const extra of [{ organizationId: "other" }, { earlyCheckout: true }, { actionsEnabled: true }, { propertyId: "other" }]) {
    assert.equal((await h.request(path, { ...update, ...extra })).status, 400);
  }
  assert.equal(h.events.length, 0);
});
test("only platform administration can grant or revoke with revision checks", async t => {
  const h = await harness(t, "PLATFORM_ADMIN");
  assert.equal((await h.request("/api/internal/pin-ai/organizations/org-a", { enabled: false, expectedRevision: 1 })).status, 200);
  assert.equal(h.organization.pinAIEnabled, false);
  assert.equal((await h.request("/api/internal/pin-ai/organizations/org-a", { enabled: true, expectedRevision: 1 })).status, 409);
  assert.equal(h.events.length, 1);
});

test("enabling requires current price acceptance; disabling does not", async t => {
  const h = await harness(t);
  const { acceptedTermsVersion, ...noConsent } = update;
  assert.equal((await h.request(path, noConsent)).status, 428);
  assert.equal((await h.request(path, { ...update, acceptedTermsVersion: "obsolete" })).status, 428);
  assert.equal(h.events.length, 0);
  const saved = await (await h.request(path, update)).json();
  assert.equal(saved.billing.amountCents, 100);
  assert.equal(saved.billing.currency, "USD");
  assert.equal(saved.billing.acceptedVersion, acceptedTermsVersion);
  assert.ok(saved.billing.acceptedAt);
  assert.equal(h.property.pinAITermsAcceptedBy, "host-a");
  assert.equal((await h.request(path, { enabled: false, expectedRevision: 1, organizationRevision: 1 })).status, 200);
  assert.equal(h.property.pinAITermsVersion, acceptedTermsVersion);
});

test("activation rejects incompatible Connect and unavailable verification without saving consent", async t => {
  const h = await harness(t);
  h.setCompatibility(false);
  assert.equal((await h.request(path, update)).status, 422);
  assert.equal(h.property.pinAITermsAcceptedAt, null);
  h.setUnavailable();
  assert.equal((await h.request(path, update)).status, 503);
  assert.equal(h.events.length, 0);
});
test("activation requires Connect; disable never calls Stripe", async t => {
  const h = await harness(t);
  h.organization.stripeConnectAccountId = "";
  assert.equal((await h.request(path, update)).status, 422);
  assert.equal(h.reads(), 0);
  assert.equal((await h.request(path, { enabled: false, expectedRevision: 0, organizationRevision: 1 })).status, 200);
  assert.equal(h.reads(), 0);
});
test("account replaced during verification cannot commit acceptance", async t => {
  const h = await harness(t);
  h.setAfterCheck(() => { h.organization.stripeConnectAccountId = "acct_changed"; });
  assert.equal((await h.request(path, update)).status, 409);
  assert.equal(h.property.pinAITermsAcceptedAt, null);
  assert.equal(h.events.length, 0);
});

test("disable and re-enable preserve current acceptance, including an explicit repeat", async t => {
  const h = await harness(t);
  const acceptedAt = new Date("2026-10-01T12:00:00Z");
  Object.assign(h.property, { pinAIEnabled: true, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    pinAITermsAcceptedAt: acceptedAt, pinAITermsAcceptedBy: "original-host" });
  assert.equal((await h.request(path, { enabled: false, expectedRevision: 0, organizationRevision: 1 })).status, 200);
  const { acceptedTermsVersion: _terms, ...noConsent } = update;
  assert.equal((await h.request(path, { ...noConsent, expectedRevision: 1 })).status, 200);
  assert.equal((await h.request(path, { ...update, expectedRevision: 2 })).status, 200);
  assert.equal(h.property.pinAITermsAcceptedAt, acceptedAt);
  assert.equal(h.property.pinAITermsAcceptedBy, "original-host");
  assert.equal(h.reads(), 2);
});

for (const evidence of [
  { pinAITermsVersion: "obsolete", pinAITermsAcceptedAt: new Date(), pinAITermsAcceptedBy: "original-host" },
  { pinAITermsVersion: PIN_AI_BILLING_TERMS.version, pinAITermsAcceptedAt: null, pinAITermsAcceptedBy: "original-host" },
  { pinAITermsVersion: PIN_AI_BILLING_TERMS.version, pinAITermsAcceptedAt: new Date(), pinAITermsAcceptedBy: null },
]) {
  test(`stale or incomplete acceptance requires renewal: ${JSON.stringify(evidence)}`, async t => {
    const h = await harness(t);
    Object.assign(h.property, evidence);
    const { acceptedTermsVersion: _terms, ...noConsent } = update;
    assert.equal((await h.request(path, noConsent)).status, 428);
    assert.equal(h.reads(), 0);
    assert.equal((await h.request(path, update)).status, 200);
    assert.equal(h.property.pinAITermsAcceptedBy, "host-a");
    assert.equal(h.property.pinAITermsVersion, PIN_AI_BILLING_TERMS.version);
    assert.ok(h.property.pinAITermsAcceptedAt);
  });
}

test("acceptance is rechecked after external Connect verification", async t => {
  const h = await harness(t);
  Object.assign(h.property, { pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    pinAITermsAcceptedAt: new Date(), pinAITermsAcceptedBy: "original-host" });
  h.setAfterCheck(() => { h.property.pinAITermsAcceptedBy = null; });
  const { acceptedTermsVersion: _terms, ...noConsent } = update;
  assert.equal((await h.request(path, noConsent)).status, 428);
  assert.equal(h.property.pinAIEnabled, false);
  assert.equal(h.events.length, 0);
});
