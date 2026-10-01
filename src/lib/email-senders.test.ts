import assert from "node:assert/strict";
import test from "node:test";
import { getEmailSender } from "./email-senders.js";
import { deliverMfaEmailOtp } from "../auth/mfa-email-otp-delivery.js";

test("approved identities reach Resend independently of the legacy sender", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM,
    NODE_ENV: process.env.NODE_ENV, PASSWORD_RESET_URL: process.env.PASSWORD_RESET_URL };
  process.env.RESEND_API_KEY = "re_offline_sender_test";
  process.env.EMAIL_FROM = "Legacy <legacy@example.com>";
  process.env.NODE_ENV = "production";
  process.env.PASSWORD_RESET_URL = "https://app.example.com/reset";
  const requests: Array<{ from: string; to: unknown; reply_to?: string; html?: string }> = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    assert.equal(options?.method, "POST");
    requests.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ id: `offline-${requests.length}` }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const mailer = await import("./mailer.js");
    const fixture = {
      to: "guest@example.com", replyTo: "host@example.com", resetUrl: "https://app.example.com/reset",
      reservationNumber: "PG-OFFLINE", propertyName: "Test property", guestName: "Test guest",
      checkIn: new Date("2026-10-02T19:00:00Z"), checkOut: new Date("2026-10-03T15:00:00Z"),
      validFrom: new Date("2026-10-02T19:00:00Z"), validUntil: new Date("2026-10-03T15:00:00Z"),
      cancelledAt: new Date("2026-10-01T12:00:00Z"), propertyTimeZone: "America/Puerto_Rico",
      passcode: "123456", preferredLanguage: "es", currency: "USD", totalAmount: 100,
      verificationUrl: "https://app.example.com/verify", reviewUrl: "https://app.example.com/review",
      manageReservationUrl: "https://app.example.com/manage", reservationDetailUrl: "https://app.example.com/reservation",
      dashboardUrl: "https://app.example.com/dashboard", idempotencyKey: "offline-sender-test",
      guestResponse: "ACCEPTED", reason: "Test cancellation", sourceName: "Test OTA", missingFields: ["EMAIL"],
      cleanerName: "Test cleaner", lockName: "Test lock", reference: "GI-OFFLINE", category: "WATER", quotes: ["Test report"],
    };
    const cases: Array<[keyof typeof mailer, string, Record<string, unknown>?]> = [
      ["sendResetPasswordEmail", "Pin&Go Security <no-reply@auth.pin-ngo.com>"],
      ["sendSalesFollowUpEmail", "Pin&Go <sales@pin-ngo.com>"],
      ["sendDirectBookingGuestConfirmation", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendManualReservationGuestConfirmation", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendDirectBookingHostNotification", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendDirectBookingGuestCancellationEmail", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendDirectBookingHostCancellationNotification", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendManualReservationGuestCancellationEmail", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendGuestPreCheckinEmail", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendGuestVerificationReminderEmail", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendReviewInvitationEmail", "Pin&Go Reservations <reservations@pin-ngo.com>"],
      ["sendGuestAccessPasscodeEmail", "Pin&Go Access <access@pin-ngo.com>"],
      ["sendCleaningHostAttentionEmail", "Pin&Go Cleaning <cleaning@pin-ngo.com>", { to: ["host@example.com"] }],
      ["sendGuestIncidentHostNotice", "Pin&Go Incidents <incidents@incidents.pin-ngo.com>"],
      ["sendDeviceGatewayCriticalAlertEmail", "Pin&Go Incidents <incidents@incidents.pin-ngo.com>", { to: ["host@example.com"] }],
      ["sendPropertyProtectionGuestDamageNotice", "Pin&Go Incidents <incidents@incidents.pin-ngo.com>"],
      ["sendPropertyProtectionGuestClosureNotice", "Pin&Go Incidents <incidents@incidents.pin-ngo.com>"],
      ["sendPropertyProtectionHostGuestResponseNotice", "Pin&Go Incidents <incidents@incidents.pin-ngo.com>"],
      ["sendGuestContactRecoveryHostNotice", "Pin&Go Alerts <alerts@incidents.pin-ngo.com>"],
    ];
    for (const [name, expectedFrom, overrides] of cases) {
      await t.test(name, async () => {
        const before = requests.length;
        const send = mailer[name] as (input: any) => Promise<unknown>;
        await send({ ...fixture, ...overrides });
        await send({ ...fixture, ...overrides });
        assert.equal(requests.length, before + 2, "both attempts must reach the offline provider");
        assert.equal(requests[before]?.from, expectedFrom);
        assert.equal(requests[before + 1]?.from, expectedFrom);
        if (["sendGuestAccessPasscodeEmail", "sendGuestPreCheckinEmail", "sendDirectBookingGuestConfirmation"].includes(name)) {
          assert.equal(requests[before]?.reply_to, "host@example.com");
          assert.equal(requests[before + 1]?.reply_to, "host@example.com");
        }
      });
    }
    const { sendPasswordResetEmail } = await import("./email.js");
    await sendPasswordResetEmail({ to: fixture.to, token: "offline-token" });
    assert.equal(requests.at(-1)?.from, "Pin&Go Security <no-reply@auth.pin-ngo.com>");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("MFA initial delivery and resend use authentication identity without EMAIL_FROM", async () => {
  const senders: string[] = [];
  for (const legacyFrom of [undefined, "Legacy <legacy@example.com>"]) {
    await deliverMfaEmailOtp({ destination: "host@example.com", code: "123456", expiresInMinutes: 5 }, {
      env: { PINGO_MFA_EMAIL_DELIVERY: "RESEND", RESEND_API_KEY: "offline-key", EMAIL_FROM: legacyFrom },
      sender: async (input) => { senders.push(input.from); return { providerMessageId: "offline-mfa" }; },
    });
  }
  assert.deepEqual(senders, Array(2).fill("Pin&Go Security <no-reply@auth.pin-ngo.com>"));
  assert.equal(getEmailSender("billing"), "Pin&Go Billing <billing@pin-ngo.com>");
});
