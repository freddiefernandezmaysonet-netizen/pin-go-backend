import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyState,
  ReservationStatus,
} from "@prisma/client";

import {
  ensureGuestJourneyForCancelledReservation,
} from "./guest-journey.service";

type MockInput = {
  reservationStatus?: ReservationStatus;
  journeyState?: GuestJourneyState;
  createCount?: number;
  updateCount?: number;
  cancelledAt?: Date | null;
  externalUpdatedAt?: Date | null;
};

function createMockTransaction(
  input: MockInput = {}
) {
  const cancelledAt =
    input.cancelledAt === undefined
      ? new Date("2026-08-06T12:00:00.000Z")
      : input.cancelledAt;

  const externalUpdatedAt =
    input.externalUpdatedAt === undefined
      ? null
      : input.externalUpdatedAt;

  const journeyState =
    input.journeyState ??
    GuestJourneyState.JOURNEY_CANCELLED;

  const calls = {
    reservationFindUnique: [] as any[],
    journeyCreateMany: [] as any[],
    journeyFindUniqueOrThrow: [] as any[],
    journeyFindUnique: [] as any[],
    journeyUpdateMany: [] as any[],
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
      createMany: async (args: any) => {
        calls.journeyCreateMany.push(args);

        return {
          count:
            input.createCount ?? 1,
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
          currentState: journeyState,
        };
      },

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
    externalUpdatedAt,
  };
}

test(
  "initializes a first-observed cancelled reservation directly as JOURNEY_CANCELLED",
  async () => {
    const {
      tx,
      calls,
      cancelledAt,
    } = createMockTransaction();

    const result =
      await ensureGuestJourneyForCancelledReservation(
        tx,
        " reservation-1 ",
        new Date(
          "2026-08-06T12:10:00.000Z"
        )
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState.JOURNEY_CANCELLED,
      created: true,
      transitioned: true,
    });

    assert.equal(
      calls.journeyCreateMany.length,
      1
    );

    assert.deepEqual(
      calls.journeyCreateMany[0],
      {
        data: {
          reservationId: "reservation-1",
          currentState:
            GuestJourneyState
              .JOURNEY_CANCELLED,
          stateChangedAt: cancelledAt,
          cancelledAt,
        },
        skipDuplicates: true,
      }
    );

    assert.equal(
      calls.auditCreate.length,
      1
    );

    const audit =
      calls.auditCreate[0].data;

    assert.equal(
      audit.decisionId,
      "guest-journey:journey-1:cancelled-reservation-initialization"
    );

    assert.equal(
      audit.metadata.initializationMode,
      "DIRECT_TERMINAL_INITIALIZATION"
    );

    assert.equal(
      audit.decisions[0].previousValue,
      null
    );

    assert.equal(
      audit.decisions[0].newValue,
      GuestJourneyState.JOURNEY_CANCELLED
    );
  }
);

test(
  "uses externalUpdatedAt when cancelledAt is unavailable",
  async () => {
    const externalUpdatedAt =
      new Date(
        "2026-08-06T11:55:00.000Z"
      );

    const {
      tx,
      calls,
    } = createMockTransaction({
      cancelledAt: null,
      externalUpdatedAt,
    });

    await ensureGuestJourneyForCancelledReservation(
      tx,
      "reservation-1"
    );

    assert.equal(
      calls.journeyCreateMany[0]
        .data.stateChangedAt,
      externalUpdatedAt
    );

    assert.equal(
      calls.journeyCreateMany[0]
        .data.cancelledAt,
      externalUpdatedAt
    );
  }
);

test(
  "transitions an existing non-terminal journey instead of synthesizing another journey",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      createCount: 0,
      journeyState:
        GuestJourneyState
          .READY_FOR_ARRIVAL,
    });

    const result =
      await ensureGuestJourneyForCancelledReservation(
        tx,
        "reservation-1"
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState.JOURNEY_CANCELLED,
      transitioned: true,
      created: false,
    });

    assert.equal(
      calls.journeyCreateMany.length,
      1
    );

    assert.equal(
      calls.journeyUpdateMany.length,
      1
    );

    assert.equal(
      calls.auditCreate.length,
      1
    );

    assert.equal(
      calls.auditCreate[0].data.decisionId,
      "guest-journey:journey-1:journey-cancelled"
    );
  }
);

test(
  "is idempotent when a concurrent worker already created JOURNEY_CANCELLED",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      createCount: 0,
      journeyState:
        GuestJourneyState
          .JOURNEY_CANCELLED,
    });

    const result =
      await ensureGuestJourneyForCancelledReservation(
        tx,
        "reservation-1"
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState.JOURNEY_CANCELLED,
      transitioned: false,
      created: false,
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
  "does not overwrite a concurrently completed journey",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      createCount: 0,
      journeyState:
        GuestJourneyState
          .JOURNEY_COMPLETED,
    });

    const result =
      await ensureGuestJourneyForCancelledReservation(
        tx,
        "reservation-1"
      );

    assert.deepEqual(result, {
      journeyId: "journey-1",
      currentState:
        GuestJourneyState.JOURNEY_COMPLETED,
      transitioned: false,
      created: false,
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
  "rejects terminal initialization when the reservation remains ACTIVE",
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
        ensureGuestJourneyForCancelledReservation(
          tx,
          "reservation-1"
        ),
      /with status ACTIVE/
    );

    assert.equal(
      calls.journeyCreateMany.length,
      0
    );

    assert.equal(
      calls.auditCreate.length,
      0
    );
  }
);
