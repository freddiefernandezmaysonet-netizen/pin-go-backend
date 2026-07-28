import assert from "node:assert/strict";
import test from "node:test";

import { addUtcDays } from "./channex-ari-lifecycle.policy";
import { buildChannexAriAvailabilitySnapshot } from "./channex-ari-availability-snapshot.policy";

function buildDateKeys(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addUtcDays(from, index));
}

test("builds a canonical Availability-only payload", () => {
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: " property-1 ",
    channexRoomTypeId: " room-1 ",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-03", "2026-08-01", "2026-08-02", "2026-08-01"],
  });

  assert.deepEqual(snapshot.payload, {
    values: [
      {
        property_id: "property-1",
        room_type_id: "room-1",
        date: "2026-08-01",
        availability: 1,
      },
      {
        property_id: "property-1",
        room_type_id: "room-1",
        date: "2026-08-02",
        availability: 1,
      },
      {
        property_id: "property-1",
        room_type_id: "room-1",
        date: "2026-08-03",
        availability: 1,
      },
    ],
  });
  assert.deepEqual(snapshot.unavailableDateKeys, []);
  assert.equal(snapshot.payloadValueCount, 3);
  assert.equal(snapshot.dateFrom, "2026-08-01");
  assert.equal(snapshot.dateToExclusive, "2026-08-04");
  assert.ok(snapshot.payloadBytes > 0);
  assert.match(snapshot.payloadHash, /^[a-f0-9]{64}$/);

  for (const value of snapshot.payload.values) {
    assert.deepEqual(Object.keys(value), [
      "property_id",
      "room_type_id",
      "date",
      "availability",
    ]);
  }
});

test("keeps the reservation checkout date available", () => {
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ],
    activeReservationRanges: [
      {
        startsAt: new Date("2026-08-01T19:00:00.000Z"),
        endsAt: new Date("2026-08-04T15:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(snapshot.unavailableDateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
  assert.deepEqual(
    snapshot.payload.values.map((value) => value.availability),
    [0, 0, 0, 1]
  );
});

test("uses the property timezone rather than UTC calendar slices", () => {
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-01", "2026-08-02", "2026-08-03"],
    activeReservationRanges: [
      {
        startsAt: new Date("2026-08-02T01:00:00.000Z"),
        endsAt: new Date("2026-08-04T15:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(snapshot.unavailableDateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
});

test("combines active reservations and manual blocks without double counting", () => {
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ],
    activeReservationRanges: [
      {
        startsAt: new Date("2026-08-01T19:00:00.000Z"),
        endsAt: new Date("2026-08-04T15:00:00.000Z"),
      },
    ],
    blockedRanges: [
      {
        startsAt: new Date("2026-08-03T04:00:00.000Z"),
        endsAt: new Date("2026-08-06T04:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(snapshot.unavailableDateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
  ]);
  assert.equal(snapshot.payload.values.length, 5);
});

test("preserves a partial same-day manual block", () => {
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-05", "2026-08-06"],
    blockedRanges: [
      {
        startsAt: new Date("2026-08-05T13:00:00.000Z"),
        endsAt: new Date("2026-08-05T20:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(snapshot.unavailableDateKeys, ["2026-08-05"]);
  assert.deepEqual(
    snapshot.payload.values.map((value) => value.availability),
    [0, 1]
  );
});

test("produces a stable hash regardless of input order and duplicates", () => {
  const first = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-03", "2026-08-01", "2026-08-02"],
    blockedRanges: [
      {
        startsAt: new Date("2026-08-02T04:00:00.000Z"),
        endsAt: new Date("2026-08-03T04:00:00.000Z"),
      },
    ],
  });

  const second = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-02",
    ],
    blockedRanges: [
      {
        startsAt: new Date("2026-08-02T04:00:00.000Z"),
        endsAt: new Date("2026-08-03T04:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(first.payload, second.payload);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(first.payloadBytes, second.payloadBytes);
});

test("accepts exactly 500 contiguous dates", () => {
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: buildDateKeys("2026-07-28", 500),
  });

  assert.equal(snapshot.payloadValueCount, 500);
  assert.equal(snapshot.dateFrom, "2026-07-28");
  assert.equal(snapshot.dateToExclusive, "2027-12-10");
});

test("rejects more than 500 dates and sparse scopes wider than 500 days", () => {
  assert.throws(
    () =>
      buildChannexAriAvailabilitySnapshot({
        channexPropertyId: "property-1",
        channexRoomTypeId: "room-1",
        propertyTimezone: "America/Puerto_Rico",
        dateKeys: buildDateKeys("2026-07-28", 501),
      }),
    /CHANNEX_ARI_AVAILABILITY_DATE_KEYS_EXCEED_HORIZON/
  );

  assert.throws(
    () =>
      buildChannexAriAvailabilitySnapshot({
        channexPropertyId: "property-1",
        channexRoomTypeId: "room-1",
        propertyTimezone: "America/Puerto_Rico",
        dateKeys: ["2026-07-28", "2027-12-10"],
      }),
    /CHANNEX_ARI_AVAILABILITY_SCOPE_EXCEEDS_HORIZON/
  );
});

test("rejects missing mapping, dates, timezone and invalid occupied ranges", () => {
  assert.throws(
    () =>
      buildChannexAriAvailabilitySnapshot({
        channexPropertyId: " ",
        channexRoomTypeId: "room-1",
        propertyTimezone: "America/Puerto_Rico",
        dateKeys: ["2026-08-01"],
      }),
    /CHANNEX_ARI_CHANNEX_PROPERTY_ID_REQUIRED/
  );

  assert.throws(
    () =>
      buildChannexAriAvailabilitySnapshot({
        channexPropertyId: "property-1",
        channexRoomTypeId: "room-1",
        propertyTimezone: "Invalid\/Timezone",
        dateKeys: ["2026-08-01"],
      }),
    /CHANNEX_ARI_PROPERTY_TIMEZONE_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriAvailabilitySnapshot({
        channexPropertyId: "property-1",
        channexRoomTypeId: "room-1",
        propertyTimezone: "America/Puerto_Rico",
        dateKeys: [],
      }),
    /CHANNEX_ARI_AVAILABILITY_DATE_KEYS_REQUIRED/
  );

  assert.throws(
    () =>
      buildChannexAriAvailabilitySnapshot({
        channexPropertyId: "property-1",
        channexRoomTypeId: "room-1",
        propertyTimezone: "America/Puerto_Rico",
        dateKeys: ["2026-08-01"],
        activeReservationRanges: [
          {
            startsAt: new Date("2026-08-01T19:00:00.000Z"),
            endsAt: new Date("2026-08-01T18:00:00.000Z"),
          },
        ],
      }),
    /CHANNEX_ARI_RESERVATION_0_RANGE_INVALID/
  );
});
