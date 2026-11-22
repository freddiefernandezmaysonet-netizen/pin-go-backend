import assert from "node:assert/strict";
import test from "node:test";
import { buildGuestReservationEmail } from "./email-templates/guestReservationEmail.js";

test("general booking instructions remain visible without Pin AI in both languages", () => {
  for (const language of ["es", "en"] as const) {
    const input = { mode: "DIRECT_BOOKING" as const, language, reservationNumber: "PG-TEST",
      propertyName: "Demo <property>", checkIn: "check-in", checkOut: "checkout",
      manageReservationBlock: '<a href="https://example.test/manage">Manage</a>' };
    for (const pinAIEnabled of [undefined, false, true]) {
      const html = buildGuestReservationEmail({ ...input, ...(pinAIEnabled === undefined ? {} : { pinAIEnabled }) });
      assert.equal(html.includes("Pin AI"), pinAIEnabled === true);
      assert.ok(html.includes(language === "es" ? "Tu estadía, paso a paso" : "Your stay, step by step"));
      assert.ok(html.includes("Demo &lt;property&gt;"));
      assert.equal((html.match(/href=/g) ?? []).length, 1);
    }
    assert.equal(buildGuestReservationEmail({ ...input, mode: "MANUAL", pinAIEnabled: true }).includes("Pin AI"), false);
  }
});

test("confirmation delivery rechecks activation on retry and hides Pin AI after deactivation", async t => {
  const settings = { RESEND_API_KEY: "re_offline_guidance", PIN_AI_GUEST_GATEWAY_ENABLED: "true",
    PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
    PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: "org-a" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const { prisma } = await import("./prisma.js");
  let enabled = true;
  let reads = 0;
  const originalFindFirst = prisma.property.findFirst;
  t.after(() => { prisma.property.findFirst = originalFindFirst; });
  prisma.property.findFirst = (async ({ where }: { where: unknown }) => {
    reads++;
    assert.deepEqual(where, { id: "property-a", organizationId: "org-a", status: "ACTIVE" });
    return { pinAIEnabled: enabled, pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1",
      organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_synthetic" } };
  }) as unknown as typeof prisma.property.findFirst;
  const emails: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    emails.push(JSON.parse(String(options.body)).html);
    return new Response(JSON.stringify({ id: "offline-only" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const { sendDirectBookingGuestConfirmation } = await import("./mailer.js");
  const payload = { to: "guest@example.test", reservationNumber: "PG-TEST", propertyName: "Test",
    checkIn: new Date("2026-12-20T20:00:00Z"), checkOut: new Date("2026-12-22T16:00:00Z"),
    manageReservationUrl: "https://example.test/manage", verificationUrl: "https://example.test/verify",
    pinAIPropertyScope: { propertyId: "property-a", organizationId: "org-a" } };
  await sendDirectBookingGuestConfirmation(payload);
  enabled = false;
  await sendDirectBookingGuestConfirmation(payload);
  assert.ok(emails[0]?.includes("Pin AI"));
  assert.equal(emails[1]?.includes("Pin AI"), false);
  assert.equal(reads, 2);
  const { pinAIPropertyScope: _scope, ...legacyPayload } = payload;
  await sendDirectBookingGuestConfirmation(legacyPayload);
  assert.equal(emails[2]?.includes("Pin AI"), false);
  assert.equal(reads, 2);
});
