import test from "node:test";
import assert from "node:assert/strict";

import { sendCheckoutSms } from "./checkoutSms.service";

function fakePrisma(externalRaw: unknown) {
  return {
    messageDispatchLog: {
      findFirst: async () => null,
    },
    reservation: {
      findUnique: async () => ({
        id: "res_checkout_consent_guard",
        guestName: "Guest",
        guestPhone: "+17875550123",
        preferredLanguage: "es",
        checkOut: new Date("2026-09-16T15:00:00.000Z"),
        externalRaw,
        property: {
          id: "property_1",
          organizationId: "org_1",
          name: "Casa Collores",
          timezone: "America/Puerto_Rico",
        },
      }),
    },
  } as any;
}

function clearTwilioEnv() {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_API_KEY;
  delete process.env.TWILIO_API_SECRET;
  delete process.env.TWILIO_FROM_NUMBER;
}

test("checkout SMS is skipped when guest SMS is disabled", async () => {
  clearTwilioEnv();
  process.env.GUEST_SMS_ENABLED = "0";

  const result = await sendCheckoutSms(
    fakePrisma({
      consent: {
        acceptedAt: "2026-09-15T12:00:00.000Z",
        smsConsent: true,
      },
    }),
    "res_checkout_consent_guard"
  );

  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "GUEST_SMS_DISABLED",
  });
});

test("checkout SMS is skipped when SMS consent is absent", async () => {
  clearTwilioEnv();
  process.env.GUEST_SMS_ENABLED = "1";

  const result = await sendCheckoutSms(
    fakePrisma({ consent: { smsConsent: false } }),
    "res_checkout_consent_guard"
  );

  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "SMS_CONSENT_NOT_GRANTED",
  });
});

test("checkout SMS accepts explicit stay-notification consent with acceptedAt", async () => {
  clearTwilioEnv();
  process.env.GUEST_SMS_ENABLED = "1";

  const prisma = fakePrisma({
    consent: {
      acceptedAt: "2026-09-15T12:00:00.000Z",
      smsConsent: false,
      stayNotificationsConsent: true,
    },
  });

  const result = await sendCheckoutSms(
    prisma,
    "res_checkout_consent_guard"
  );

  assert.equal(result.ok, false);
  assert.match(String(result.error), /Missing Twilio env/);
});
