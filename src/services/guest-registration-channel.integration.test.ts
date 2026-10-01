import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";

import { ensureReservationGuestAgreementSnapshot } from "./guest-agreement.service";

import { sendGuestVerificationReminder } from "./guest-verification-reminder.service";
import { ensureGuestJourneyForConfirmedReservation, scheduleGuestJourneyAccess } from "./guest-journey.service";

// Isolated fixtures only: never use live Stripe credentials in this test process.
process.env.STRIPE_SECRET_KEY = "sk_test_channex_local_fixture";
process.env.APP_URL = "http://127.0.0.1";
const { buildGuestRouter } = await import("../routes/guest.routes");
const { createGuestIdentityVerificationSession } = await import("./guest-identity-verification.service");

const row = () => ({
  id: "reservation-1", reservationNumber: "PG-TEST", propertyId: "property-1",
  externalProvider: "CHANNEX", externalId: "ota-1", status: "ACTIVE", paymentState: "PAID",
  checkIn: new Date(Date.now() + 60_000), checkOut: new Date(Date.now() + 86_400_000),
  guestToken: "test-token", guestTokenExpiresAt: new Date(Date.now() + 172_800_000),
  preferredLanguage: "es", verificationStatus: "PENDING", guestAgreementSnapshot: null,
  property: { organizationId: "org-1", name: "Test", timezone: "America/Puerto_Rico" },
});

// Missing write/provider delegates make any attempt to capture agreement or start
// identity fail the test; only the supplied reads are allowed.
test("Channex import does not require a property agreement and reminders are skipped", async () => {
  const prisma = { reservation: { findUnique: async () => row() } } as never;
  const agreement = await ensureReservationGuestAgreementSnapshot(prisma, "reservation-1");
  assert.equal(agreement.ok, true);
  assert.equal(agreement.snapshot, null);
  const reminder = await sendGuestVerificationReminder(prisma, "reservation-1");
  assert.equal(reminder.skippedReason, "CHANNEX_REGISTRATION_NOT_REQUIRED");
  await assert.rejects(createGuestIdentityVerificationSession(prisma, {
    reservationId: "reservation-1", returnUrl: "https://example.test/return",
  }), /GUEST_IDENTITY_VERIFICATION_NOT_REQUIRED/);
});

test("old Channex verification GET and empty POST redirect without any form or writes", async () => {
  let valid = true;
  const prisma = { reservation: { findFirst: async ({ where }: any) => {
    assert.equal(where.guestToken, "test-token");
    assert.ok(where.guestTokenExpiresAt.gt instanceof Date);
    return valid ? row() : null;
  } } } as never;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(buildGuestRouter(prisma));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/guest/verify/test-token`;
    for (const method of ["GET", "POST"]) {
      const response = await fetch(url, { method, redirect: "manual" });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/guest/test-token");
      assert.doesNotMatch(await response.text(), /name="legalName"|identityConsentAccepted/);
    }
    valid = false;
    const invalid = await fetch(url, { redirect: "manual" });
    assert.equal(invalid.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

for (const state of ["RESERVATION_CONFIRMED", "VERIFICATION_PENDING", "VERIFICATION_COMPLETED"]) {
  test(`Channex transitions ${state} to scheduled only with actual released grant evidence`, async () => {
    let currentState = state;
    const audit: any[] = [];
    const reservation = { ...row(), guestAccessReleaseStatus: "RELEASED", guestAccessReleasedAt: new Date() };
    const tx = {
      reservation: { findUnique: async () => reservation },
      guestJourney: {
        findUnique: async () => ({ id: "journey-1", currentState }),
        updateMany: async ({ where, data }: any) => {
          assert.equal(where.currentState, currentState);
          assert.equal("verificationCompletedAt" in data, false);
          currentState = data.currentState;
          return { count: 1 };
        },
      },
      accessGrant: { findFirst: async () => ({ id: "grant-1", ttlockKeyboardPwdId: "1", secureAccessCode: { id: "code-1" },
        startsAt: reservation.checkIn, endsAt: reservation.checkOut }) },
      apmsAuditEntry: { findUnique: async () => null, create: async ({ data }: any) => { audit.push(data); return data; } },
    } as never;
    const result = await scheduleGuestJourneyAccess(tx, reservation.id, "grant-1");
    assert.equal(result.currentState, "ACCESS_SCHEDULED");
    assert.equal(audit[0].metadata.fromState, state);
    const repeat = await scheduleGuestJourneyAccess(tx, reservation.id, "grant-1");
    assert.equal(repeat.transitioned, false);
    assert.equal(audit.length, 1);
    reservation.guestAccessReleaseStatus = "BLOCKED";
    await assert.rejects(scheduleGuestJourneyAccess(tx, reservation.id, "grant-1"), /without released access evidence/);
  });
}

test("new Channex journey stays confirmed instead of requesting guest verification", async () => {
  const result = await ensureGuestJourneyForConfirmedReservation({
    reservation: { findUnique: async () => row() },
    guestJourney: { findUnique: async () => null,
      create: async ({ data }: any) => ({ id: "journey-1", currentState: data.currentState }) },
  } as never, "reservation-1");
  assert.equal(result.currentState, "RESERVATION_CONFIRMED");
  assert.equal(result.transitioned, false);
});

test("Direct Booking still cannot schedule from verification pending", async () => {
  const reservation = { ...row(), externalProvider: null, externalId: null,
    guestAccessReleaseStatus: "RELEASED", guestAccessReleasedAt: new Date() };
  await assert.rejects(scheduleGuestJourneyAccess({
    reservation: { findUnique: async () => reservation },
    accessGrant: { findFirst: async () => ({ id: "grant-1", ttlockKeyboardPwdId: "1", secureAccessCode: { id: "code-1" } }) },
    guestJourney: { findUnique: async () => ({ id: "journey-1", currentState: "VERIFICATION_PENDING" }) },
  } as never, "reservation-1", "grant-1"), /Invalid Guest Journey transition/);
});
