import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestAccessMode,
  GuestAccessReleaseStatus,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import {
  evaluateGuestAccessReadiness,
} from "./guest-access-readiness.service";

const NOW = new Date(
  "2026-08-22T12:00:00.000Z"
);

function reservation(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: "reservation-1",
    reservationNumber: "PG-1",
    propertyId: "property-1",
    status: ReservationStatus.ACTIVE,
    paymentState: PaymentState.PAID,
    checkIn: new Date(
      "2026-08-23T20:00:00.000Z"
    ),
    checkOut: new Date(
      "2026-08-25T15:00:00.000Z"
    ),
    verificationStatus: "COMPLETED",
    verifiedAt: NOW,
    verificationAcceptedRulesAt: NOW,
    guestAgreementSnapshot: {
      requiresIdentityVerification:
        true,
    },
    guestAgreementAcceptance: {
      accepted: true,
    },
    guestAgreementSignedAt: NOW,
    guestAccessModeSnapshot:
      GuestAccessMode.PASSCODE_ONLY,
    guestAccessReleaseStatus:
      GuestAccessReleaseStatus.BLOCKED,
    guestAccessEligibleAt: null,
    property: {
      organizationId: "org-1",
    },
    ...overrides,
  };
}

test("fences the E5 readiness write by organization and property", async () => {
  const updateManyCalls: any[] = [];
  const result =
    await evaluateGuestAccessReadiness(
      {
        reservation: {
          findUnique: async () =>
            reservation(),
          updateMany: async (
            args: any
          ) => {
            updateManyCalls.push(args);
            return { count: 1 };
          },
          update: async () => {
            throw new Error(
              "unfenced update must not run"
            );
          },
        },
      } as never,
      "reservation-1",
      {
        now: NOW,
        persist: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      }
    );

  assert.equal(result.ready, true);
  assert.equal(
    updateManyCalls[0].where
      .propertyId,
    "property-1"
  );
  assert.equal(
    updateManyCalls[0].where
      .property.organizationId,
    "org-1"
  );
});

test("rejects a mismatched tenant before any readiness write", async () => {
  let wrote = false;

  await assert.rejects(
    evaluateGuestAccessReadiness(
      {
        reservation: {
          findUnique: async () =>
            reservation(),
          updateMany: async () => {
            wrote = true;
            return { count: 1 };
          },
        },
      } as never,
      "reservation-1",
      {
        now: NOW,
        persist: true,
        expectedScope: {
          organizationId:
            "another-org",
          propertyId: "property-1",
        },
      }
    ),
    /EVALUATION_SCOPE_MISMATCH/
  );

  assert.equal(wrote, false);
});

test("fails closed when the reservation leaves the canary during the write", async () => {
  await assert.rejects(
    evaluateGuestAccessReadiness(
      {
        reservation: {
          findUnique: async () =>
            reservation(),
          updateMany: async () => ({
            count: 0,
          }),
        },
      } as never,
      "reservation-1",
      {
        now: NOW,
        persist: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      }
    ),
    /EVALUATION_SCOPE_CHANGED/
  );
});
