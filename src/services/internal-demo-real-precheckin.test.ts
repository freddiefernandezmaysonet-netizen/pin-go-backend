import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";

process.env.RESEND_API_KEY = "re_synthetic_never_sent";
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_never_sent";

test("Demo confirmation invites the participant in both languages while ordinary confirmation is unchanged", async t => {
  const originalFetch = globalThis.fetch;
  const emails: any[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    emails.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `synthetic-${emails.length}` });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { sendDirectBookingGuestConfirmation } = await import("../lib/mailer.js");
  const payload = {
    to: "guest@example.invalid", reservationNumber: "PG-2026-000067", propertyName: "Demo",
    checkIn: new Date("2027-01-01T20:00:00Z"), checkOut: new Date("2027-01-03T15:00:00Z"),
    verificationUrl: "https://api.example.invalid/guest/verify/synthetic-token",
    manageReservationUrl: "https://app.example.invalid/booking/manage/synthetic-token",
    demoGuestAgreement: { title: "Agreement <safe>", version: "1", agreementText: "Terms & conditions" },
  };
  for (const preferredLanguage of ["es", "en"]) {
    await sendDirectBookingGuestConfirmation({ ...payload, preferredLanguage,
      demoSimulation: true, demoPrecheckinRequired: true });
    const html = emails.at(-1).html;
    assert.ok(html.includes(payload.verificationUrl));
    assert.ok(html.includes("Agreement &lt;safe&gt;"));
    assert.ok(html.includes(preferredLanguage === "es" ? "Aún no está firmado" : "It has not been signed yet"));
    assert.ok(html.includes(preferredLanguage === "es" ? "no se realizó ningún cobro" : "no charge was made"));
    assert.ok(!html.includes("aceptación es simulada"));
    assert.ok(!html.includes("Acceptance is simulated"));
  }
  await sendDirectBookingGuestConfirmation({ ...payload, preferredLanguage: "en" });
  const commercial = emails.at(-1).html;
  assert.ok(commercial.includes(payload.verificationUrl));
  assert.ok(!commercial.includes("Agreement &lt;safe&gt;"));
  assert.ok(!commercial.includes("payment is simulated"));
});

test("resuming a pending Demo sends confirmations without creating guest acceptance, including repeated requests", async () => {
  const { runInternalDemo } = await import("./internal-demo-run.service.js");
  const { INTERNAL_DEMO_PROPERTY_ID } = await import("./internal-demo-scope.js");
  const input = { checkIn: new Date(Date.now() + 86400000), checkOut: new Date(Date.now() + 2 * 86400000),
    guestName: "Demo participant", guestEmail: "guest@example.invalid", guestPhone: "+12025550123",
    preferredLanguage: "es", smsConsent: true, cleanerId: "cleaner", primaryAdminEmail: "host@example.invalid",
    afterHoursAuthorized: true };
  const requestId = randomUUID();
  const r: any = { id: "reservation", propertyId: INTERNAL_DEMO_PROPERTY_ID,
    source: "INTERNAL_DEMO_DIRECT_BOOKING", externalProvider: "PIN_GO_INTERNAL_DEMO", externalId: `DEMO-${requestId}`,
    ...input, property: { organizationId: "org", status: "ACTIVE", name: "Demo", timezone: "America/Puerto_Rico" },
    guestAgreementSignedAt: null, guestAgreementAcceptance: null, guestAccessReleaseStatus: "PENDING",
    accessGrants: [], NfcAssignment: [], externalRaw: { demo: true, paymentSimulated: true,
      demoRun: { stage: "CREATION", fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex") } } };
  const writes: any[] = [];
  const db: any = {
    $transaction: async (f: any) => f(db), $executeRawUnsafe: async () => 1,
    reservation: { findFirst: async (q: any) => q.where.id ? null : r, findUniqueOrThrow: async () => r,
      update: async ({ data }: any) => { writes.push(data); Object.assign(r, data); return r; } },
    messageLog: { findMany: async () => [] }, cleaningConfirmation: { findMany: async () => [] },
    cleaningWork: { findMany: async () => [] }, pinAIGuestConversation: { findUnique: async () => null },
    operationalIssue: { findMany: async () => [] },
  };
  let confirmations = 0;
  const deps: any = { ingest: async () => { throw new Error("Must reuse the existing reservation"); },
    secure: async () => { throw new Error("Must not simulate guest acceptance"); },
    parity: async () => { confirmations++; return { guestEmail: { ok: true }, hostEmail: { sent: 1 } }; },
    cleaning: async () => ({ ok: true }) };
  const actor = { userId: "admin", organizationId: "org", role: "PLATFORM_ADMIN", email: "host@example.invalid" };
  for (let i = 0; i < 2; i++) {
    const result = await runInternalDemo(db, actor, { ...input, requestId }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.data.secureReady, false);
    assert.equal(result.data.identitySimulated, false);
    assert.equal(r.guestAgreementSignedAt, null);
    assert.equal(r.guestAgreementAcceptance, null);
  }
  assert.equal(confirmations, 1);
  assert.ok(writes.every(data => Object.keys(data).every(k => k === "externalRaw")));
});
