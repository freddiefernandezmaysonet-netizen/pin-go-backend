import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyState,
  ReservationStatus,
} from "@prisma/client";

import {
  completeGuestJourney,
  markGuestJourneyCheckoutDue,
  markGuestJourneyStayActive,
} from "./guest-journey.service";

type AccessGrantEvidence = {
  id: string;
  status: string;
  method?: string;
  ttlockKeyboardPwdId?: string | null;
  revokedReason?: string | null;
  lastError?: string | null;
};

type NfcEvidence = {
  id: string;
  status: string;
  lastError?: string | null;
};

type MockInput = {
  reservationStatus?: ReservationStatus;
  journeyState?: GuestJourneyState;
  guestAccessReleaseStatus?: string;
  guestAccessReleasedAt?: Date | null;
  checkIn?: Date;
  checkOut?: Date;
  updateCount?: number;
  concurrentState?: GuestJourneyState;
  accessGrants?: AccessGrantEvidence[];
  unresolvedNfc?: NfcEvidence | null;
};

function createMockTransaction(
  input: MockInput = {}
) {
  const checkIn =
    input.checkIn ??
    new Date("2026-08-06T10:00:00.000Z");

  const checkOut =
    input.checkOut ??
    new Date("2026-08-06T12:00:00.000Z");

  const guestAccessReleasedAt =
    input.guestAccessReleasedAt === undefined
      ? new Date("2026-08-06T09:55:00.000Z")
      : input.guestAccessReleasedAt;

  const journeyState =
    input.journeyState ??
    GuestJourneyState.READY_FOR_ARRIVAL;

  const calls = {
    reservationFindUnique: [] as any[],
    journeyFindUnique: [] as any[],
    journeyUpdateMany: [] as any[],
    journeyFindUniqueOrThrow: [] as any[],
    accessGrantFindMany: [] as any[],
    nfcAssignmentFindFirst: [] as any[],
    auditFindUnique: [] as any[],
    auditCreate: [] as any[],
  };

  const tx = {
    reservation: {
      findUnique: async (args: any) => {
        calls.reservationFindUnique.push(args);

        return {
          id: "reservation-1",
          status:
            input.reservationStatus ??
            ReservationStatus.ACTIVE,
          propertyId: "property-1",
          checkIn,
          checkOut,
          guestAccessReleaseStatus:
            input.guestAccessReleaseStatus ??
            "RELEASED",
          guestAccessReleasedAt,
          property: {
            organizationId:
              "organization-1",
          },
        };
      },
    },

    guestJourney: {
      findUnique: async (args: any) => {
        calls.journeyFindUnique.push(args);

        return {
          id: "journey-1",
          currentState: journeyState,
        };
      },

      updateMany: async (args: any) => {
        calls.journeyUpdateMany.push(args);

        return {
          count:
            input.updateCount ?? 1,
        };
      },

      findUniqueOrThrow: async (
        args: any
      ) => {
        calls.journeyFindUniqueOrThrow.push(
          args
        );

        return {
          id: "journey-1",
          currentState:
            input.concurrentState ??
            GuestJourneyState
              .JOURNEY_COMPLETED,
        };
      },
    },

    accessGrant: {
      findMany: async (args: any) => {
        calls.accessGrantFindMany.push(args);

        return (
          input.accessGrants ?? [
            {
              id: "grant-1",
              status: "REVOKED",
              method:
                "PASSCODE_TIMEBOUND",
              ttlockKeyboardPwdId:
                "keyboard-password-1",
              revokedReason:
                "CHECKOUT_COMPLETED",
              lastError: null,
            },
          ]
        );
      },
    },

    nfcAssignment: {
      findFirst: async (args: any) => {
        calls.nfcAssignmentFindFirst.push(
          args
        );

        return input.unresolvedNfc ?? null;
      },
    },

    apmsAuditEntry: {
      findUnique: async (args: any) => {
        calls.auditFindUnique.push(args);
        return null;
      },

      create: async (args: any) => {
        calls.auditCreate.push(args);

        return {
          id: "audit-1",
          ...args.data,
        };
      },
    },
  };

  return {
    tx: tx as any,
    calls,
    checkIn,
    checkOut,
    guestAccessReleasedAt,
  };
}

test(
  "transitions READY_FOR_ARRIVAL to STAY_ACTIVE when the scheduled stay window begins",
  async () => {
    const now =
      new Date(
        "2026-08-06T10:30:00.000Z"
      );

    const {
      tx,
      calls,
      guestAccessReleasedAt,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState
          .READY_FOR_ARRIVAL,
    });

    const result =
      await markGuestJourneyStayActive(
        tx,
        " reservation-1 ",
        now
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState.STAY_ACTIVE,
      transitioned: true,
    });

    assert.equal(
      calls.journeyUpdateMany.length,
      1
    );

    assert.deepEqual(
      calls.journeyUpdateMany[0].where,
      {
        id: "journey-1",
        currentState:
          GuestJourneyState
            .READY_FOR_ARRIVAL,
      }
    );

    assert.equal(
      calls.journeyUpdateMany[0]
        .data.currentState,
      GuestJourneyState.STAY_ACTIVE
    );

    assert.equal(
      calls.journeyUpdateMany[0]
        .data.stayActiveAt,
      now
    );

    assert.equal(
      calls.auditCreate.length,
      1
    );

    const audit =
      calls.auditCreate[0].data;

    assert.equal(
      audit.decisionId,
      "guest-journey:journey-1:ready-for-arrival-to-stay-active"
    );

    assert.equal(
      audit.metadata
        .physicalArrivalConfirmed,
      false
    );

    assert.equal(
      audit.metadata
        .guestAccessReleasedAt,
      guestAccessReleasedAt
    );
  }
);

test(
  "rejects STAY_ACTIVE before the scheduled check-in time",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState
          .READY_FOR_ARRIVAL,
    });

    await assert.rejects(
      () =>
        markGuestJourneyStayActive(
          tx,
          "reservation-1",
          new Date(
            "2026-08-06T09:59:59.000Z"
          )
        ),
      /before 2026-08-06T10:00:00.000Z/
    );

    assert.equal(
      calls.journeyFindUnique.length,
      0
    );

    assert.equal(
      calls.journeyUpdateMany.length,
      0
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);

test(
  "transitions STAY_ACTIVE to CHECKOUT_DUE when scheduled checkout is reached",
  async () => {
    const now =
      new Date(
        "2026-08-06T12:00:00.000Z"
      );

    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState.STAY_ACTIVE,
    });

    const result =
      await markGuestJourneyCheckoutDue(
        tx,
        "reservation-1",
        now
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState.CHECKOUT_DUE,
      transitioned: true,
    });

    assert.deepEqual(
      calls.journeyUpdateMany[0].where,
      {
        id: "journey-1",
        currentState:
          GuestJourneyState.STAY_ACTIVE,
      }
    );

    assert.equal(
      calls.journeyUpdateMany[0]
        .data.checkoutDueAt,
      now
    );

    assert.equal(
      calls.auditCreate.length,
      1
    );

    const audit =
      calls.auditCreate[0].data;

    assert.equal(
      audit.decisionId,
      "guest-journey:journey-1:stay-active-to-checkout-due"
    );

    assert.equal(
      audit.metadata
        .accessRevocationCompleted,
      false
    );
  }
);

test(
  "rejects CHECKOUT_DUE before scheduled checkout",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState.STAY_ACTIVE,
    });

    await assert.rejects(
      () =>
        markGuestJourneyCheckoutDue(
          tx,
          "reservation-1",
          new Date(
            "2026-08-06T11:59:59.000Z"
          )
        ),
      /before 2026-08-06T12:00:00.000Z/
    );

    assert.equal(
      calls.journeyFindUnique.length,
      0
    );

    assert.equal(
      calls.journeyUpdateMany.length,
      0
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);

test(
  "completes CHECKOUT_DUE only after all persisted guest access is closed",
  async () => {
    const now =
      new Date(
        "2026-08-06T12:10:00.000Z"
      );

    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState.CHECKOUT_DUE,
      accessGrants: [
        {
          id: "grant-1",
          status: "REVOKED",
          method:
            "PASSCODE_TIMEBOUND",
          ttlockKeyboardPwdId:
            "keyboard-password-1",
          revokedReason:
            "CHECKOUT_COMPLETED",
          lastError: null,
        },
        {
          id: "grant-2",
          status: "REVOKED",
          method:
            "AUTHORIZED_ADMIN",
          ttlockKeyboardPwdId: null,
          revokedReason:
            "CHECKOUT_COMPLETED",
          lastError: null,
        },
      ],
      unresolvedNfc: null,
    });

    const result =
      await completeGuestJourney(
        tx,
        "reservation-1",
        now
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState
          .JOURNEY_COMPLETED,
      transitioned: true,
    });

    assert.equal(
      calls.accessGrantFindMany.length,
      1
    );

    assert.equal(
      calls.nfcAssignmentFindFirst.length,
      1
    );

    assert.equal(
      calls.journeyUpdateMany[0]
        .data.completedAt,
      now
    );

    assert.equal(
      calls.auditCreate.length,
      1
    );

    const audit =
      calls.auditCreate[0].data;

    assert.equal(
      audit.decisionId,
      "guest-journey:journey-1:checkout-due-to-journey-completed"
    );

    assert.equal(
      audit.metadata
        .guestAccessGrantCount,
      2
    );

    assert.equal(
      audit.metadata
        .allGuestAccessGrantsRevoked,
      true
    );

    assert.equal(
      audit.metadata
        .unresolvedGuestNfc,
      false
    );
  }
);

test(
  "blocks completion while a guest access grant remains unresolved",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState.CHECKOUT_DUE,
      accessGrants: [
        {
          id: "grant-1",
          status: "ACTIVE",
          method:
            "PASSCODE_TIMEBOUND",
          ttlockKeyboardPwdId:
            "keyboard-password-1",
          revokedReason: null,
          lastError:
            "TTLOCK_REVOKE_FAILED",
        },
      ],
    });

    await assert.rejects(
      () =>
        completeGuestJourney(
          tx,
          "reservation-1",
          new Date(
            "2026-08-06T12:10:00.000Z"
          )
        ),
      /1 guest access grant\(s\) remain unresolved/
    );

    assert.equal(
      calls.nfcAssignmentFindFirst.length,
      0
    );

    assert.equal(
      calls.journeyUpdateMany.length,
      0
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);

test(
  "blocks completion while a guest NFC assignment remains unresolved",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState.CHECKOUT_DUE,
      accessGrants: [
        {
          id: "grant-1",
          status: "REVOKED",
          method:
            "PASSCODE_TIMEBOUND",
          ttlockKeyboardPwdId:
            "keyboard-password-1",
          revokedReason:
            "CHECKOUT_COMPLETED",
          lastError: null,
        },
      ],
      unresolvedNfc: {
        id: "nfc-assignment-1",
        status: "FAILED",
        lastError:
          "TTLOCK_REVOKE_FAILED",
      },
    });

    await assert.rejects(
      () =>
        completeGuestJourney(
          tx,
          "reservation-1",
          new Date(
            "2026-08-06T12:10:00.000Z"
          )
        ),
      /guest NFC assignment nfc-assignment-1 remains FAILED/
    );

    assert.equal(
      calls.journeyUpdateMany.length,
      0
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);

test(
  "does not overwrite JOURNEY_CANCELLED during completion",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState
          .JOURNEY_CANCELLED,
    });

    const result =
      await completeGuestJourney(
        tx,
        "reservation-1",
        new Date(
          "2026-08-06T12:10:00.000Z"
        )
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState
          .JOURNEY_CANCELLED,
      transitioned: false,
    });

    assert.equal(
      calls.accessGrantFindMany.length,
      0
    );

    assert.equal(
      calls.nfcAssignmentFindFirst.length,
      0
    );

    assert.equal(
      calls.journeyUpdateMany.length,
      0
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);
