import assert from "node:assert/strict";
import test from "node:test";
import { DamageCaseStatus } from "@prisma/client";
import { getGuestDamageCasePortalView } from "./guest-damage-case-portal.service.js";

function fakePrisma(reservation: any) {
  return {
    reservation: {
      findFirst: async () => reservation,
    },
  } as any;
}

const protectedReservation = {
  reservationNumber: "PG-2026-000051",
  roomName: "Demo",
  currency: "usd",
  propertyProtectionRequiredSnapshot: true,
  propertyProtectionModeSnapshot: "CARD_ON_FILE",
  maxDamageLiabilityAmountSnapshot: 500,
  property: { name: "Pin&Go Demo Property" },
  damageCase: {
    id: "damage-1",
    status: DamageCaseStatus.GUEST_NOTIFICATION_PENDING,
    requestedAmount: 300,
    approvedAmount: 250,
    currency: "usd",
    description: "Documented damage",
    evidence: { notes: "Inspection notes" },
    hostApprovedAt: new Date("2026-09-22T19:00:00.000Z"),
    guestNotifiedAt: null,
    closedAt: null,
    closedReason: null,
    updatedAt: new Date("2026-09-22T19:00:00.000Z"),
  },
};

test("guest portal exposes an approved Damage Case without financial object IDs", async () => {
  const result = await getGuestDamageCasePortalView(
    fakePrisma(protectedReservation),
    { guestToken: "guest-token" }
  );

  assert.equal(result.damageCase?.status, "GUEST_NOTIFICATION_PENDING");
  assert.equal(result.damageCase?.approvedAmount, 250);
  assert.equal(result.damageCase?.chargeExecuted, false);
  assert.equal(result.propertyProtection?.maxDamageLiabilityAmount, 500);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /stripeDamageCustomerId|stripeDamagePaymentMethodId|paymentIntent/i);
});

test("draft and host-review cases remain private from the guest portal", async () => {
  for (const status of [
    DamageCaseStatus.OPEN,
    DamageCaseStatus.EVIDENCE_PENDING,
    DamageCaseStatus.HOST_REVIEW,
  ]) {
    const result = await getGuestDamageCasePortalView(
      fakePrisma({
        ...protectedReservation,
        damageCase: { ...protectedReservation.damageCase, status },
      }),
      { guestToken: "guest-token" }
    );
    assert.equal(result.damageCase, null);
  }
});

test("unprotected reservations return no Property Protection case", async () => {
  const result = await getGuestDamageCasePortalView(
    fakePrisma({
      ...protectedReservation,
      propertyProtectionRequiredSnapshot: false,
      damageCase: null,
    }),
    { guestToken: "guest-token" }
  );
  assert.equal(result.propertyProtection, null);
  assert.equal(result.damageCase, null);
});

test("guest lookup enforces the existing Manage Reservation token expiry", async () => {
  let capturedWhere: any = null;
  const prisma = {
    reservation: {
      findFirst: async (args: any) => {
        capturedWhere = args.where;
        return protectedReservation;
      },
    },
  } as any;

  await getGuestDamageCasePortalView(prisma, {
    guestToken: "guest-token",
    now: new Date("2026-09-22T19:00:00.000Z"),
  });

  assert.equal(capturedWhere.guestToken, "guest-token");
  assert.deepEqual(capturedWhere.OR[0], { guestTokenExpiresAt: null });
  assert.ok(capturedWhere.OR[1].guestTokenExpiresAt.gt instanceof Date);
});
