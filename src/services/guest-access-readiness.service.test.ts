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

for (const snapshot of [null, { requiresIdentityVerification: true }, { requiresIdentityVerification: false }]) {
  for (const verificationStatus of ["PENDING", "REVIEW_REQUIRED", "NOT_REQUIRED"]) {
    test(`Channex access ignores inherited registration: ${JSON.stringify(snapshot)} / ${verificationStatus}`, async () => {
      const row = reservation({ externalProvider: "CHANNEX", externalId: "ota-1", verificationStatus,
        verifiedAt: null, guestAgreementSnapshot: snapshot, guestAgreementSignedAt: null,
        guestAgreementAcceptance: null, verificationAcceptedRulesAt: null });
      let written: any;
      const result = await evaluateGuestAccessReadiness({ reservation: {
        findUnique: async ({ select }: any) => {
          assert.equal(select.externalProvider, true);
          assert.equal(select.externalId, true);
          return row;
        },
        update: async ({ data }: any) => { written = data; },
      }} as never, row.id, { now: NOW });
      assert.equal(result.ready, true);
      assert.deepEqual(result.blockers, []);
      assert.equal(written.guestAccessReleaseStatus, "ELIGIBLE");
      assert.equal(written.guestAccessReleaseLastError, null);
      assert.equal("verifiedAt" in written, false);
      assert.equal("guestAgreementSignedAt" in written, false);
    });
  }
}

test("Channex exemption preserves active, checkout and payment controls", async () => {
  const result = await evaluateGuestAccessReadiness({ reservation: { findUnique: async () => reservation({
    externalProvider: "CHANNEX", externalId: "ota-1", status: "CANCELLED", paymentState: "NONE", checkOut: NOW,
  }) }} as never, "reservation-1", { now: NOW, persist: false });
  assert.deepEqual(result.blockers, ["RESERVATION_NOT_ACTIVE", "STAY_ALREADY_ENDED", "PAYMENT_NOT_PAID"]);
});

for (const provenance of [{}, { externalProvider: "DIRECT_BOOKING", externalId: "ota-1" }, { externalProvider: "CHANNEX", externalId: null }]) {
  test(`unproven channel keeps all Direct Booking requirements ${JSON.stringify(provenance)}`, async () => {
    const result = await evaluateGuestAccessReadiness({ reservation: { findUnique: async () => reservation({
      ...provenance, verificationStatus: "PENDING", verifiedAt: null, guestAgreementSnapshot: null,
      guestAgreementSignedAt: null, guestAgreementAcceptance: null, verificationAcceptedRulesAt: null,
    }) }} as never, "reservation-1", { now: NOW, persist: false });
    assert.deepEqual(result.blockers, ["GUEST_IDENTITY_NOT_VERIFIED", "GUEST_AGREEMENT_SNAPSHOT_MISSING",
      "GUEST_AGREEMENT_NOT_SIGNED", "GUEST_AGREEMENT_ACCEPTANCE_MISSING", "PROPERTY_RULES_NOT_ACCEPTED"]);
  });
}
