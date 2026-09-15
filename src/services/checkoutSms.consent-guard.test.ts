import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sendCheckoutSms } from "./checkoutSms.service";
import { evaluateCheckoutSmsConsent } from "./checkout-sms-consent.policy";

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

async function withGuestSmsEnabled<T>(
  value: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env.GUEST_SMS_ENABLED;
  process.env.GUEST_SMS_ENABLED = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.GUEST_SMS_ENABLED;
    } else {
      process.env.GUEST_SMS_ENABLED = previous;
    }
  }
}

test("checkout consent policy blocks when guest SMS is disabled", () => {
  assert.deepEqual(
    evaluateCheckoutSmsConsent(
      {
        consent: {
          acceptedAt: "2026-09-15T12:00:00.000Z",
          smsConsent: true,
        },
      },
      { GUEST_SMS_ENABLED: "0" } as NodeJS.ProcessEnv
    ),
    {
      allowed: false,
      reason: "GUEST_SMS_DISABLED",
    }
  );
});

test("checkout consent policy requires accepted consent evidence", () => {
  assert.deepEqual(
    evaluateCheckoutSmsConsent(
      { consent: { smsConsent: true } },
      { GUEST_SMS_ENABLED: "1" } as NodeJS.ProcessEnv
    ),
    {
      allowed: false,
      reason: "SMS_CONSENT_NOT_GRANTED",
    }
  );
});

test("checkout consent policy accepts smsConsent with acceptedAt", () => {
  assert.deepEqual(
    evaluateCheckoutSmsConsent(
      {
        consent: {
          acceptedAt: "2026-09-15T12:00:00.000Z",
          smsConsent: true,
        },
      },
      { GUEST_SMS_ENABLED: "1" } as NodeJS.ProcessEnv
    ),
    { allowed: true }
  );
});

test("checkout consent policy accepts stayNotificationsConsent with acceptedAt", () => {
  assert.deepEqual(
    evaluateCheckoutSmsConsent(
      {
        consent: {
          acceptedAt: "2026-09-15T12:00:00.000Z",
          smsConsent: false,
          stayNotificationsConsent: true,
        },
      },
      { GUEST_SMS_ENABLED: "1" } as NodeJS.ProcessEnv
    ),
    { allowed: true }
  );
});

test("checkout SMS is skipped before Twilio when guest SMS is disabled", async () => {
  clearTwilioEnv();

  const result = await withGuestSmsEnabled("0", () =>
    sendCheckoutSms(
      fakePrisma({
        consent: {
          acceptedAt: "2026-09-15T12:00:00.000Z",
          smsConsent: true,
        },
      }),
      "res_checkout_consent_guard"
    )
  );

  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "GUEST_SMS_DISABLED",
  });
});

test("checkout SMS is skipped before Twilio when consent is absent", async () => {
  clearTwilioEnv();

  const result = await withGuestSmsEnabled("1", () =>
    sendCheckoutSms(
      fakePrisma({ consent: { smsConsent: false } }),
      "res_checkout_consent_guard"
    )
  );

  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "SMS_CONSENT_NOT_GRANTED",
  });
});

test("checkout SMS reaches transport only when consent is allowed", async () => {
  clearTwilioEnv();

  const result = await withGuestSmsEnabled("1", () =>
    sendCheckoutSms(
      fakePrisma({
        consent: {
          acceptedAt: "2026-09-15T12:00:00.000Z",
          smsConsent: false,
          stayNotificationsConsent: true,
        },
      }),
      "res_checkout_consent_guard"
    )
  );

  assert.equal(result.ok, false);
  assert.match(String(result.error), /Missing Twilio env/);
});

test("checkout SMS retry evaluates consent before Twilio transport", () => {
  const source = readFileSync(
    new URL("../workers/message.retry.worker.ts", import.meta.url),
    "utf8"
  );

  const checkoutGuardIndex = source.indexOf(
    'String(msg.communicationType ?? "").toUpperCase() === "CHECKOUT"'
  );
  const consentIndex = source.indexOf(
    "evaluateCheckoutSmsConsent",
    checkoutGuardIndex
  );
  const sendIndex = source.indexOf(
    "const sent = await sendSms(msg.to, msg.body)",
    checkoutGuardIndex
  );

  assert.notEqual(checkoutGuardIndex, -1);
  assert.notEqual(consentIndex, -1);
  assert.notEqual(sendIndex, -1);
  assert.ok(consentIndex < sendIndex);
});
