import assert from "node:assert/strict";
import test from "node:test";
const env = { CHANNEX_AIRBNB_ACCESS_ENABLED: "true", CHANNEX_AIRBNB_ACCESS_ORGANIZATION_IDS: "org", CHANNEX_AIRBNB_ACCESS_PROPERTY_IDS: "prop", CHANNEX_AIRBNB_ACCESS_RESERVATION_IDS: "res" };
function blockedFixture() {
  const r: any = { id: "res", source: "Airbnb", externalProvider: "CHANNEX", externalId: "invalid-booking", propertyId: "prop", property: { organizationId: "org" }, status: "ACTIVE", paymentState: "PAID", checkOut: new Date("2100-01-01") };
  const receipts = new Map<string, any>();
  const prisma: any = {
    reservation: { findUnique: async () => r },
    messageLog: { updateMany: async ({ where, data }: any) => { const row = receipts.get(where.id); if (!row || row.status !== where.status) return { count: 0 }; Object.assign(row, data); return { count: 1 }; } },
  };
  return { r, receipts, prisma, posts: 0 };
}

test("initial email/SMS entrypoints never fall back when Airbnb is blocked", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const f = blockedFixture(); f.r.externalId = "invalid-booking";
    const { sendLoggedEmail } = await import("./email-delivery.service.js");
    const { sendGuestPasscodeSms } = await import("./messaging.service.js");
    const { sendPreCheckinEmail, sendPreCheckinSms } = await import("./preCheckinSms.service.js");
    const { sendCheckoutSms } = await import("./checkoutSms.service.js");
    let emailCalls = 0;
    const email = await sendLoggedEmail({ prisma: f.prisma, type: "GUEST_ACCESS_PASSCODE", reservationId: "res", to: "guest@example.test", subject: "test", send: async () => { emailCalls++; } });
    assert.equal(email.ok, false); assert.equal(emailCalls, 0);
    const sms = await sendGuestPasscodeSms({ prisma: f.prisma, reservationId: "res", guestPhone: "+17875550100", code: "test", validUntil: f.r.checkOut });
    assert.equal(sms.ok, false);
    for (const send of [sendPreCheckinEmail, sendPreCheckinSms, sendCheckoutSms]) assert.equal((await send(f.prisma, "res")).ok, false);
    assert.equal(f.posts, 0);
  } finally {
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("legacy retries are retired while staff messages remain untouched", async () => {
  const previous = { ...process.env }; Object.assign(process.env, env);
  try {
    const f = blockedFixture(); const { retireAirbnbLegacyRetry } = await import("../channex-messaging/airbnb-access.service.js");
    const legacy = { id: "old", reservationId: "res", communicationType: "GUEST_ACCESS_PASSCODE", status: "FAILED" };
    f.receipts.set("old", { ...legacy });
    assert.equal(await retireAirbnbLegacyRetry(f.prisma, legacy), true);
    assert.equal(f.receipts.get("old").status, "OBSOLETE");
    assert.equal(await retireAirbnbLegacyRetry(f.prisma, { ...legacy, communicationType: "CLEANING_START" }), false);
    assert.equal(await retireAirbnbLegacyRetry(f.prisma, { ...legacy, status: "SENT" }), false);
  } finally {
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
