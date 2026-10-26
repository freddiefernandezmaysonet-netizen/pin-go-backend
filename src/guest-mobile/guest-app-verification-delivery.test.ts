import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { guestAppVerificationChannel } from "./guest-app-verification-channel.policy.js";
import { deliverGuestAppVerification, sendGuestAppVerificationEmail } from "./guest-app-verification-delivery.service.js";

test("Airbnb and Booking use their booking conversation; Direct Booking, Expedia and Vrbo use the saved reservation email", () => {
  for (const source of ["AIRBNB", "Air_Bnb", "Booking.com", "BookingCom", "BOOKING_COM"]) {
    assert.equal(guestAppVerificationChannel({ source, externalProvider: "CHANNEX", externalId: "booking", guestEmail: "guest@example.com" }), "CHANNEX");
    assert.equal(guestAppVerificationChannel({ source, externalProvider: "CHANNEX", externalId: null, guestEmail: "guest@example.com" }), null);
  }
  for (const source of ["DIRECT_BOOKING", "EXPEDIA", "Expedia", "VRBO", "Vrbo", "MANUAL"]) {
    assert.equal(guestAppVerificationChannel({ source, guestEmail: "guest@example.com" }), "EMAIL");
    assert.equal(guestAppVerificationChannel({ source, guestEmail: null }), null);
  }
  for (const guestEmail of ["", "bad", "one@example.com,two@example.com", "Guest <one@example.com>", "one@example.com\nBcc:other@example.com"])
    assert.equal(guestAppVerificationChannel({ source: "VRBO", guestEmail }), null);
});

for (const source of ["DIRECT_BOOKING", "EXPEDIA", "VRBO"]) {
  test(`${source}: verification goes only to the saved email, logs no secret and sends once per challenge`, async () => {
    const stay = { id: "stay", propertyId: "property", source, externalProvider: source === "DIRECT_BOOKING" ? "PIN_GO_DIRECT" : "CHANNEX",
      externalId: "booking", guestEmail: "guest@example.com", preferredLanguage: "es", property: { organizationId: "org" } };
    const receipts = new Map<string, any>(); let emailSends = 0, channexSends = 0;
    const db = {
      reservation: { findFirst: async () => structuredClone(stay) },
      messageLog: {
        findUnique: async ({ where }: any) => receipts.get(where.id) ?? null,
        create: async ({ data }: any) => { receipts.set(data.id, structuredClone(data)); return data; },
        updateMany: async ({ where, data }: any) => {
          const row = receipts.get(where.id); if (!row || row.status !== where.status) return { count: 0 };
          Object.assign(row, data); return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const input = { reservationId: "stay", challengeId: "c".repeat(32), code: "123456" };
    const dependencies = {
      sendEmail: async (mail: any) => { emailSends++; assert.equal(mail.to, stay.guestEmail); assert.equal(mail.code, input.code); return "accepted-email"; },
      sendChannex: (async () => { channexSends++; throw Error("Wrong channel"); }) as any,
    };
    assert.equal(await deliverGuestAppVerification(db, input, dependencies), true);
    assert.equal(await deliverGuestAppVerification(db, input, dependencies), true);
    assert.equal(emailSends, 1); assert.equal(channexSends, 0);
    const receipt = [...receipts.values()][0];
    assert.equal(receipt.status, "SENT"); assert.equal(receipt.organizationId, "org"); assert.equal(receipt.reservationId, "stay");
    assert.ok(!JSON.stringify(receipt).includes(input.code));
    const uncertain = { ...input, challengeId: "d".repeat(32) };
    let attempts = 0;
    const failing = { ...dependencies, sendEmail: async () => { attempts++; throw Error("Synthetic timeout"); } };
    assert.equal(await deliverGuestAppVerification(db, uncertain, failing), false);
    assert.equal(await deliverGuestAppVerification(db, uncertain, failing), false);
    assert.equal(attempts, 1);
    assert.equal(receipts.get(`guestappverify_${uncertain.challengeId}`).status, "EMAIL_VERIFICATION_UNKNOWN");
    stay.guestEmail = "";
    assert.equal(await deliverGuestAppVerification(db, { ...input, challengeId: "e".repeat(32) }, dependencies), false);
    assert.equal(emailSends, 1);
  });
}

test("Airbnb verification failure never falls back to email", async () => {
  let emails = 0, channex = 0;
  const db = { reservation: { findFirst: async () => ({ id: "r", source: "Airbnb", externalProvider: "CHANNEX", externalId: "b", guestEmail: "guest@example.com" }) } } as unknown as PrismaClient;
  assert.equal(await deliverGuestAppVerification(db, { reservationId: "r", challengeId: "c".repeat(32), code: "123456" }, {
    sendEmail: async () => { emails++; return "email"; },
    sendChannex: (async () => { channex++; return { ok: false, status: "FAILED" }; }) as any,
  }), false);
  assert.equal(emails, 0); assert.equal(channex, 1);
});

test("verification email uses the security sender, bilingual copy and a provider idempotency key, with strict acceptance", async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_offline_verification_test";
  const calls: any[] = []; let reject = false;
  globalThis.fetch = async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)), idempotencyKey: new Headers(init?.headers).get("idempotency-key") });
    return new Response(JSON.stringify(reject ? { name: "validation_error", message: "synthetic rejection" } : { id: "accepted-verification" }), { status: reject ? 422 : 200 });
  };
  try {
    for (const language of ["es", "en"]) {
      assert.equal(await sendGuestAppVerificationEmail({ to: "guest@example.com", code: "123456", language, idempotencyKey: "synthetic-verification" }), "accepted-verification");
      const call = calls.at(-1);
      assert.equal(call.body.from, "Pin&Go Security <no-reply@auth.pin-ngo.com>");
      assert.equal(call.body.to, "guest@example.com");
      assert.equal(call.idempotencyKey, "synthetic-verification");
      assert.match(call.body.text, /123456/);
      assert.match(call.body.html, language === "es" ? /Vence en 10 minutos/ : /Expires in 10 minutes/);
      assert.doesNotMatch(call.body.html, /guestToken|pingo-guest:|guest\/app/);
    }
    reject = true;
    await assert.rejects(sendGuestAppVerificationEmail({ to: "guest@example.com", code: "123456", language: "en", idempotencyKey: "synthetic-rejected" }), /EMAIL_NOT_ACCEPTED/);
    delete process.env.RESEND_API_KEY;
    await assert.rejects(sendGuestAppVerificationEmail({ to: "guest@example.com", code: "123456", language: "en", idempotencyKey: "synthetic-unconfigured" }), /EMAIL_UNCONFIGURED/);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey; }
});
