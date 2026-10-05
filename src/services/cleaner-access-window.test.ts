import assert from "node:assert/strict";
import test from "node:test";
import { planCleanerAccessWindow } from "./cleaner-access-window.policy";
import { readCleanerAccessWindow } from "./cleaner-access-window.service";

const departure = new Date("2026-10-27T12:00:00-04:00");

test("configured duration starts after effective checkout plus offset", () => {
  const w = planCleanerAccessWindow({
    checkOut: departure,
    property: { cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180 },
    nextCheckIn: null,
  });
  assert.equal(w.startsAt.toISOString(), "2026-10-27T16:30:00.000Z");
  assert.equal(w.endsAt.toISOString(), "2026-10-27T19:30:00.000Z");
  assert.equal(w.durationMinutes, 180);
});

test("demo property can keep a one-hour cleaner access window at any time", () => {
  const w = planCleanerAccessWindow({
    checkOut: new Date("2026-10-27T11:00:00-04:00"),
    property: { cleaningStartOffsetMinutes: 15, cleaningDurationMinutes: 60 },
    nextCheckIn: null,
  });
  assert.equal(w.startsAt.toISOString(), "2026-10-27T15:15:00.000Z");
  assert.equal(w.endsAt.toISOString(), "2026-10-27T16:15:00.000Z");
});

test("configured 240-minute window is not recalculated from standard property hours", () => {
  const w = planCleanerAccessWindow({
    checkOut: new Date("2026-10-27T11:00:00-04:00"),
    property: { cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 240 },
    nextCheckIn: null,
  });
  assert.equal(w.endsAt.toISOString(), "2026-10-27T19:30:00.000Z");
});

test("next real occupancy caps a configured window that would overlap it", () => {
  const nextCheckIn = new Date("2026-10-27T15:00:00-04:00");
  const w = planCleanerAccessWindow({
    checkOut: departure,
    property: { cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 240 },
    nextCheckIn,
  });
  assert.equal(w.endsAt.getTime(), nextCheckIn.getTime());
});

test("next arrival at or before cleaner start rejects an empty window", () => {
  for (const time of ["12:30", "12:15", "11:00"]) {
    assert.throws(
      () =>
        planCleanerAccessWindow({
          checkOut: departure,
          property: { cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180 },
          nextCheckIn: new Date(`2026-10-27T${time}:00-04:00`),
        }),
      /CLEANER_ACCESS_WINDOW_EMPTY/
    );
  }
});

test("invalid configured duration and offset fail closed", () => {
  for (const cleaningDurationMinutes of [0, -1, NaN, 1.5]) {
    assert.throws(() =>
      planCleanerAccessWindow({
        checkOut: departure,
        property: { cleaningStartOffsetMinutes: 30, cleaningDurationMinutes },
        nextCheckIn: null,
      })
    );
  }
  for (const cleaningStartOffsetMinutes of [-1, NaN, 1.5]) {
    assert.throws(() =>
      planCleanerAccessWindow({
        checkOut: departure,
        property: { cleaningStartOffsetMinutes, cleaningDurationMinutes: 180 },
        nextCheckIn: null,
      })
    );
  }
});

test("next occupancy lookup excludes same/cancelled stay and uses earliest arrival", async () => {
  let query: any;
  const nextCheckIn = new Date("2026-10-27T15:00:00-04:00");
  const db = {
    reservation: {
      findFirst: async (args: any) => {
        query = args;
        return { checkIn: nextCheckIn };
      },
    },
  };
  const property = { cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180 };
  const result = await readCleanerAccessWindow(db as any, {
    id: "r60",
    propertyId: "collores",
    checkOut: departure,
    property,
  });
  assert.deepEqual(query.where, {
    propertyId: "collores",
    id: { not: "r60" },
    status: { not: "CANCELLED" },
    checkOut: { gt: departure },
  });
  assert.deepEqual(query.orderBy, { checkIn: "asc" });
  assert.equal(result.endsAt.getTime(), nextCheckIn.getTime());
});
