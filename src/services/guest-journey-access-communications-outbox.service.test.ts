import assert from "node:assert/strict";
import test from "node:test";

import { materializeGuestAccessCommunicationOutbox } from "./guest-journey-access-communications-outbox.service";

const now = new Date("2026-08-31T18:00:00.000Z");
const checkIn = new Date("2026-08-31T19:00:00.000Z");
const checkOut = new Date("2026-09-01T15:00:00.000Z");

function fixture(existing: any[] = []) {
  const created: any[] = [];
  const reservation = {
    id: "reservation-1",
    reservationNumber: "PG-2026-000044",
    guestEmail: "guest@example.com",
    guestPhone: "+17875550101",
    preferredLanguage: "es-PR",
    externalRaw: {
      consent: {
        acceptedAt: now.toISOString(),
        smsConsent: true,
        stayNotificationsConsent: true,
      },
    },
    checkIn,
    checkOut,
    guestAccessReleaseStatus: "RELEASED",
    guestAccessReleasedAt: now,
    accessGrants: [{
      id: "grant-1",
      method: "PASSCODE_TIMEBOUND",
      status: "ACTIVE",
      startsAt: checkIn,
      endsAt: checkOut,
      updatedAt: now,
      secureAccessCode: { accessCodeHash: "hash-1" },
    }],
  };
  const prisma: any = {
    reservation: {
      findFirst: async () => reservation,
    },
    messageLog: {
      findMany: async () => existing,
      createMany: async ({ data }: any) => {
        created.push(...data);
        return { count: data.length };
      },
    },
  };
  return { prisma, reservation, created };
}

const input = {
  reservationId: "reservation-1",
  organizationId: "org-1",
  propertyId: "property-1",
  accessGrantIds: ["grant-1"],
};

test("materializer creates email and consented SMS without plaintext passcode", async () => {
  const state = fixture();
  const result = await materializeGuestAccessCommunicationOutbox(state.prisma, input);
  assert.equal(result.created, 2);
  assert.deepEqual(state.created.map((row) => row.channel).sort(), ["email", "sms"]);
  assert.ok(state.created.every((row) => row.status === "APMS_PENDING"));
  assert.ok(state.created.every((row) => row.accessGrantId === "grant-1"));
  assert.doesNotMatch(JSON.stringify(state.created), /123456|accessCodeEnc|passcodePlain/);
});

test("materializer suppresses delivery already owned for the current grant revision", async () => {
  const state = fixture([{
    channel: "email",
    to: "guest@example.com",
    status: "SENT",
    accessGrantId: null,
    body: JSON.stringify({
      kind: "PIN_GO_EMAIL_DELIVERY",
      type: "GUEST_ACCESS_PASSCODE",
      retryPayload: { accessGrantId: "grant-1" },
    }),
    createdAt: new Date(now.getTime() + 1_000),
  }]);
  const result = await materializeGuestAccessCommunicationOutbox(state.prisma, input);
  assert.equal(result.created, 1);
  assert.equal(state.created[0].channel, "sms");
});

test("materializer does not let stale delivery evidence suppress a changed grant revision", async () => {
  const state = fixture([{
    channel: "sms",
    to: "+17875550101",
    status: "SENT",
    accessGrantId: "grant-1",
    body: "masked",
    createdAt: new Date(now.getTime() - 1_000),
  }]);
  const result = await materializeGuestAccessCommunicationOutbox(state.prisma, input);
  assert.equal(result.created, 2);
});

test("materializer fails closed without released canonical secure access evidence", async () => {
  const state = fixture();
  state.reservation.guestAccessReleaseStatus = "ELIGIBLE";
  await assert.rejects(
    materializeGuestAccessCommunicationOutbox(state.prisma, input),
    /OUTBOX_RELEASE_EVIDENCE_MISSING/
  );
  assert.equal(state.created.length, 0);
});
