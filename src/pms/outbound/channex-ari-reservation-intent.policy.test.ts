import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChannexAriReservationIntent,
  type ChannexAriReservationAvailabilitySnapshot,
} from "./channex-ari-reservation-intent.policy";
import { persistChannexAriReservationIntent } from "./channex-ari-reservation-producer.service";

function snapshot(input: {
  checkIn: string;
  checkOut: string;
  status?: "ACTIVE" | "CANCELLED";
}): ChannexAriReservationAvailabilitySnapshot {
  return {
    checkIn: new Date(input.checkIn),
    checkOut: new Date(input.checkOut),
    status: input.status ?? "ACTIVE",
  };
}

function createDbMock() {
  const writes: Array<{ data: Record<string, unknown> }> = [];

  const db = {
    distributionOutboxEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(args);

        return {
          id: `outbox-${writes.length}`,
          ...args.data,
        };
      },
    },
  } as any;

  return { db, writes };
}

test("creates Availability intent for a new active reservation", () => {
  const intent = buildChannexAriReservationIntent({
    current: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent, {
    messageKind: "AVAILABILITY",
    trigger: "RESERVATION_CREATED",
    dateKeys: ["2026-08-01", "2026-08-02", "2026-08-03"],
  });
});

test("uses property-local calendar dates instead of UTC slices", () => {
  const intent = buildChannexAriReservationIntent({
    current: snapshot({
      checkIn: "2026-08-02T01:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent?.dateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
});

test("returns null when payment or guest metadata changes without inventory impact", () => {
  const previous = snapshot({
    checkIn: "2026-08-01T19:00:00.000Z",
    checkOut: "2026-08-04T15:00:00.000Z",
  });
  const current = snapshot({
    checkIn: "2026-08-01T19:00:00.000Z",
    checkOut: "2026-08-04T15:00:00.000Z",
  });

  assert.equal(
    buildChannexAriReservationIntent({
      previous,
      current,
      propertyTimezone: "America/Puerto_Rico",
      todayDateKey: "2026-07-28",
    }),
    null
  );
});

test("reopens all previously occupied nights on cancellation", () => {
  const intent = buildChannexAriReservationIntent({
    previous: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
      status: "ACTIVE",
    }),
    current: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
      status: "CANCELLED",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent, {
    messageKind: "AVAILABILITY",
    trigger: "RESERVATION_CANCELLED",
    dateKeys: ["2026-08-01", "2026-08-02", "2026-08-03"],
  });
});

test("closes all active nights when a cancelled reservation is reactivated", () => {
  const intent = buildChannexAriReservationIntent({
    previous: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
      status: "CANCELLED",
    }),
    current: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
      status: "ACTIVE",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent, {
    messageKind: "AVAILABILITY",
    trigger: "RESERVATION_REACTIVATED",
    dateKeys: ["2026-08-01", "2026-08-02", "2026-08-03"],
  });
});

test("uses the union of old and new nights when stay dates change", () => {
  const intent = buildChannexAriReservationIntent({
    previous: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
    }),
    current: snapshot({
      checkIn: "2026-08-02T19:00:00.000Z",
      checkOut: "2026-08-06T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent, {
    messageKind: "AVAILABILITY",
    trigger: "RESERVATION_DATES_CHANGED",
    dateKeys: [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ],
  });
});

test("clips past occupied nights to today", () => {
  const intent = buildChannexAriReservationIntent({
    current: snapshot({
      checkIn: "2026-07-25T19:00:00.000Z",
      checkOut: "2026-07-30T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent?.dateKeys, ["2026-07-28", "2026-07-29"]);
});

test("clips occupied nights at the 500-day horizon", () => {
  const intent = buildChannexAriReservationIntent({
    current: snapshot({
      checkIn: "2027-12-08T19:00:00.000Z",
      checkOut: "2027-12-13T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.deepEqual(intent?.dateKeys, ["2027-12-08", "2027-12-09"]);
});

test("returns null when the reservation is completely outside the active horizon", () => {
  const intent = buildChannexAriReservationIntent({
    current: snapshot({
      checkIn: "2027-12-11T19:00:00.000Z",
      checkOut: "2027-12-14T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.equal(intent, null);
});

test("returns null for a newly ingested reservation already cancelled", () => {
  const intent = buildChannexAriReservationIntent({
    current: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
      status: "CANCELLED",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.equal(intent, null);
});

test("persists the reservation Availability intent through the transaction client", async () => {
  const { db, writes } = createDbMock();
  const now = new Date("2026-07-28T12:00:00.000Z");

  const result = await persistChannexAriReservationIntent({
    db,
    organizationId: "org-1",
    propertyId: "property-1",
    reservationId: "reservation-1",
    current: snapshot({
      checkIn: "2026-08-01T19:00:00.000Z",
      checkOut: "2026-08-04T15:00:00.000Z",
    }),
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
    now,
  });

  assert.equal(result?.id, "outbox-1");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data, {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "INCREMENTAL",
    scope: "EXACT_DATES",
    dateFrom: new Date("2026-08-01T00:00:00.000Z"),
    dateToExclusive: new Date("2026-08-04T00:00:00.000Z"),
    dateKeys: ["2026-08-01", "2026-08-02", "2026-08-03"],
    trigger: "RESERVATION_CREATED",
    sourceEntityType: "RESERVATION",
    sourceEntityId: "reservation-1",
    correlationId: null,
    status: "PENDING",
    availableAt: new Date("2026-07-28T12:00:30.000Z"),
  });
});

test("does not persist an outbox event when occupied nights are unchanged", async () => {
  const { db, writes } = createDbMock();
  const unchanged = snapshot({
    checkIn: "2026-08-01T19:00:00.000Z",
    checkOut: "2026-08-04T15:00:00.000Z",
  });

  const result = await persistChannexAriReservationIntent({
    db,
    organizationId: "org-1",
    propertyId: "property-1",
    reservationId: "reservation-1",
    previous: unchanged,
    current: unchanged,
    propertyTimezone: "America/Puerto_Rico",
    todayDateKey: "2026-07-28",
  });

  assert.equal(result, null);
  assert.equal(writes.length, 0);
});

test("rejects invalid timezone, status and local stay range", () => {
  assert.throws(
    () =>
      buildChannexAriReservationIntent({
        current: snapshot({
          checkIn: "2026-08-01T19:00:00.000Z",
          checkOut: "2026-08-04T15:00:00.000Z",
        }),
        propertyTimezone: "Invalid/Timezone",
        todayDateKey: "2026-07-28",
      }),
    /CHANNEX_ARI_PROPERTY_TIMEZONE_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriReservationIntent({
        current: {
          ...snapshot({
            checkIn: "2026-08-01T19:00:00.000Z",
            checkOut: "2026-08-04T15:00:00.000Z",
          }),
          status: "UNKNOWN" as any,
        },
        propertyTimezone: "America/Puerto_Rico",
        todayDateKey: "2026-07-28",
      }),
    /CHANNEX_ARI_CURRENT_STATUS_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriReservationIntent({
        current: snapshot({
          checkIn: "2026-08-01T15:00:00.000Z",
          checkOut: "2026-08-01T20:00:00.000Z",
        }),
        propertyTimezone: "America/Puerto_Rico",
        todayDateKey: "2026-07-28",
      }),
    /CHANNEX_ARI_RESERVATION_LOCAL_STAY_RANGE_INVALID/
  );
});
