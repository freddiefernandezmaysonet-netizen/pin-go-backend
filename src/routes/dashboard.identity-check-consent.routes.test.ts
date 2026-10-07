import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import { buildGuestAccessSettingsRouter } from "./dashboard.guest-access-settings.routes.js";
const body = { guestAccessMode: "PASSCODE_ONLY", cleaningNfcEnabled: false, requiresIdentityVerification: true,
  expectedAgreementVersion: "v-original", acceptedIdentityBillingTermsVersion: "identity-check-direct-booking-usd-250-v1",
  titleEn: "Guest agreement", titleEs: "Acuerdo del huésped", agreementTextEn: "English agreement content. ".repeat(4),
  agreementTextEs: "Contenido del acuerdo en español. ".repeat(4), rulesEn: ["Rule"], rulesEs: ["Regla"] };
async function harness(t: test.TestContext, role = "ORG_ADMIN", organizationId = "org-a") {
  const prior = process.env.CI; process.env.CI = "true";
  const priorFee = process.env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT;
  process.env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT = "2.50";
  let writes = 0; let created: any;
  const tx = {
    dashboardUser: { findFirst: async ({ where }: any) => where.organizationId === "org-a" && where.role.in.includes(role) ? { id: "host-a" } : null },
    $queryRaw: async () => [],
    property: { findFirst: async () => ({ id: "property-a", name: "Synthetic", maxGuests: 4 }),
      update: async () => { writes++; return { id: "property-a", name: "Synthetic", maxGuests: 4 }; } },
    propertyGuestAgreement: { findFirst: async () => ({ version: "v-original", identityBillingTermsVersion: null,
      identityBillingAmountCents: null, identityBillingAcceptedAt: null, identityBillingAcceptedBy: null }),
      updateMany: async () => { writes++; }, create: async ({ data }: any) => { writes++; created = data; return data; } },
  };
  const db = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: "host-a", orgId: organizationId, role }; next(); });
  app.use(buildGuestAccessSettingsRouter(db));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (prior === undefined) delete process.env.CI; else process.env.CI = prior;
    if (priorFee === undefined) delete process.env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT; else process.env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT = priorFee;
  });
  return { writes: () => writes, created: () => created,
    save: (input: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/properties/property-a/guest-access-settings`,
      { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input) }) };
}
test("HTTP enabling rejects missing or stale financial acceptance before any write", async t => {
  const h = await harness(t);
  for (const acceptedIdentityBillingTermsVersion of [undefined, "old-terms"]) {
    const response = await h.save({ ...body, acceptedIdentityBillingTermsVersion });
    assert.equal(response.status, 428);
  }
  assert.equal(h.writes(), 0);
});
test("HTTP acceptance is recorded atomically with the new agreement", async t => {
  const h = await harness(t); const response = await h.save(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.identityBilling.accepted, true);
  assert.equal(h.created().identityBillingAmountCents, 250);
  assert.equal(h.created().identityBillingAcceptedBy, "host-a");
  assert.ok(h.created().identityBillingAcceptedAt instanceof Date);
});
test("HTTP disable requires no financial acceptance", async t => {
  const h = await harness(t); const response = await h.save({ ...body, requiresIdentityVerification: false, acceptedIdentityBillingTermsVersion: undefined });
  assert.equal(response.status, 200); assert.equal(h.created().identityBillingAcceptedAt, null);
});
test("HTTP stale agreement revision cannot persist acceptance", async t => {
  const h = await harness(t); const response = await h.save({ ...body, expectedAgreementVersion: "old" });
  assert.equal(response.status, 409); assert.equal(h.writes(), 0);
});
test("HTTP non-admin and wrong tenant cannot authorize a charge", async t => {
  for (const [role, org] of [["STAFF", "org-a"], ["ORG_ADMIN", "other-org"]]) {
    const h = await harness(t, role, org); assert.equal((await h.save(body)).status, 403); assert.equal(h.writes(), 0);
  }
});
test("HTTP cookie mutation without trusted origin never persists acceptance", async t => {
  const h = await harness(t); const response = await h.save(body, { Cookie: "pingo_token=synthetic" });
  assert.equal(response.status, 403); assert.equal(h.writes(), 0);
});
