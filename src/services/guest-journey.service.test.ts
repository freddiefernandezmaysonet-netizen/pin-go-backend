import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyState,
  ReservationStatus,
} from "@prisma/client";

import {
  cancelGuestJourney,
} from "./guest-journey.service";

type MockInput = {
  reservationStatus?: ReservationStatus;
  journeyState?: GuestJourneyState;
  updateCount?: number;
  stateAfterCompareAndSetMiss?: GuestJourneyState;
  cancelledAt?: Date | null;
  externalUpdatedAt?: Date | null;
  journeyExists?: boolean;
};

function createMockTransaction(
  input: MockInput = {}
) {
  const calls = {
    reservationFindUnique: [] as any[],
    journeyFindUnique: [] as any[],
    journeyUpdateMany: [] as any[],
    journeyFindUniqueOrThrow: [] as any[],
    auditFindUnique: [] as any[],
    auditCreate: [] as any[],
  };

  const journeyState =
    input.journeyState ??
    GuestJourneyState.READY_FOR_ARRIVAL;

  const cancelledAt =
    input.cancelledAt === undefined
      ? new Date("2026-08-06T12:00:00.000Z")
      : input.cancelledAt;

  const externalUpdatedAt =
    input.externalUpdatedAt === undefined
      ? null
      : input.externalUpdatedAt;

  const journeyExists =
    input.journeyExists ?? true;

  const tx = {
    reservation: {
      findUnique: async (args: any) => {
        calls.reservationFindUnique.push(args);

        return {
          id: "reservation-1",
          status:
            input.reservationStatus ??
            ReservationStatus.CANCELLED,
          propertyId: "property-1",
          cancelledAt,
          cancelledBy: "GUEST",
          cancellationReason:
            "Guest requested cancellation",
          externalProvider: "CHANNEX",
          externalUpdatedAt,
          updatedAt:
            new Date(
              "2026-08-06T12:05:00.000Z"
            ),
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

        if (!journeyExists) {
          return null;
        }

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
            input
              .stateAfterCompareAndSetMiss ??
            GuestJourneyState
              .JOURNEY_CANCELLED,
        };
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
    cancelledAt,
  };
}

test(
  "transitions a cancelled reservation journey to JOURNEY_CANCELLED and persists audit evidence",
  async () => {
    const {
      tx,
      calls,
      cancelledAt,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState
          .READY_FOR_ARRIVAL,
    });

    const result =
      await cancelGuestJourney(
        tx,
        " reservation-1 ",
        new Date(
          "2026-08-06T12:10:00.000Z"
        )
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState
          .JOURNEY_CANCELLED,
      transitioned: true,
    });

    assert.equal(
      calls.journeyUpdateMany.length,
      1
    );

    const transition =
      calls.journeyUpdateMany[0];

    assert.deepEqual(
      transition.where,
      {
        id: "journey-1",
        currentState:
          GuestJourneyState
            .READY_FOR_ARRIVAL,
      }
    );

    assert.equal(
      transition.data.currentState,
      GuestJourneyState
        .JOURNEY_CANCELLED
    );

    assert.equal(
      transition.data.stateChangedAt,
      cancelledAt
    );

    assert.equal(
      transition.data.cancelledAt,
      cancelledAt
    );

    assert.equal(
      calls.auditCreate.length,
      1
    );

    const auditData =
      calls.auditCreate[0].data;

    assert.equal(
      auditData.decisionId,
      "guest-journey:journey-1:journey-cancelled"
    );

    assert.equal(
      auditData.organizationId,
      "organization-1"
    );

    assert.equal(
      auditData.propertyId,
      "property-1"
    );

    assert.equal(
      auditData.reservationId,
      "reservation-1"
    );

    assert.equal(
      auditData.metadata
        .accessClosureOwnedBy,
      "Access Engine"
    );

    assert.equal(
      auditData.decisions[0]
        .previousValue,
      GuestJourneyState
        .READY_FOR_ARRIVAL
    );

    assert.equal(
      auditData.decisions[0]
        .newValue,
      GuestJourneyState
        .JOURNEY_CANCELLED
    );
  }
);

test(
  "is idempotent when the journey is already JOURNEY_CANCELLED",
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
      await cancelGuestJourney(
        tx,
        "reservation-1"
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState
          .JOURNEY_CANCELLED,
      transitioned: false,
    });

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
  "does not overwrite JOURNEY_COMPLETED with JOURNEY_CANCELLED",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState
          .JOURNEY_COMPLETED,
    });

    const result =
      await cancelGuestJourney(
        tx,
        "reservation-1"
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState
          .JOURNEY_COMPLETED,
      transitioned: false,
    });

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
  "rejects cancellation when the reservation is not CANCELLED",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      reservationStatus:
        ReservationStatus.ACTIVE,
    });

    await assert.rejects(
      () =>
        cancelGuestJourney(
          tx,
          "reservation-1"
        ),
      /with status ACTIVE/
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
  "returns the concurrent winner state when compare-and-set does not apply",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journeyState:
        GuestJourneyState
          .CHECKOUT_DUE,
      updateCount: 0,
      stateAfterCompareAndSetMiss:
        GuestJourneyState
          .JOURNEY_CANCELLED,
    });

    const result =
      await cancelGuestJourney(
        tx,
        "reservation-1"
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState
          .JOURNEY_CANCELLED,
      transitioned: false,
    });

    assert.equal(
      calls.journeyUpdateMany.length,
      1
    );

    assert.equal(
      calls
        .journeyFindUniqueOrThrow
        .length,
      1
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);
