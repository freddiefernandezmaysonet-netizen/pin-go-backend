import assert from "node:assert/strict";
import test from "node:test";
import { defaultCleanerAccessMinutes, planCleanerAccessWindow } from "./cleaner-access-window.policy";
import { readCleanerAccessWindow } from "./cleaner-access-window.service";

const property = { checkOutTime: "12:00", checkInTime: "16:00", timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 45 };
const departure = new Date("2026-10-27T12:00:00-04:00");
for (const [out, arrival, duration] of [["11:00", "16:00", 240], ["11:00", "15:00", 180],
  ["12:00", "16:00", 180], ["12:00", "15:00", 120]] as const) {
  test(`${out} to ${arrival}: ${duration} access minutes`, () => {
    assert.equal(defaultCleanerAccessMinutes(out, arrival), duration);
  });
}
test("Casa Collores ends at 15:45, not 16:45", () => {
  const w = planCleanerAccessWindow({ checkOut: departure, property, nextCheckIn: null });
  assert.equal(w.startsAt.toISOString(), "2026-10-27T16:45:00.000Z");
  assert.equal(w.endsAt.toISOString(), "2026-10-27T19:45:00.000Z");
});
test("approved early arrival caps cleaner access", () => {
  const nextCheckIn = new Date("2026-10-27T14:00:00-04:00");
  assert.equal(planCleanerAccessWindow({ checkOut: departure, property, nextCheckIn }).endsAt.getTime(), nextCheckIn.getTime());
});
test("later reservation never extends the property default window", () => {
  const nextCheckIn = new Date("2026-10-29T16:00:00-04:00");
  assert.equal(planCleanerAccessWindow({ checkOut: departure, property, nextCheckIn }).endsAt.toISOString(), "2026-10-27T19:45:00.000Z");
});
test("late departure and large offset never exceed standard arrival", () => {
  const w = planCleanerAccessWindow({ checkOut: new Date("2026-10-27T13:00:00-04:00"), property, nextCheckIn: null });
  assert.equal(w.endsAt.toISOString(), "2026-10-27T20:00:00.000Z");
  assert.equal(planCleanerAccessWindow({ checkOut: departure, property: { ...property, cleaningStartOffsetMinutes: 90 }, nextCheckIn: null }).endsAt.toISOString(), "2026-10-27T20:00:00.000Z");
});
test("arrival at or before cleaner start rejects empty window", () => {
  for (const time of ["12:45", "12:30", "11:00"]) assert.throws(() => planCleanerAccessWindow({
    checkOut: departure, property, nextCheckIn: new Date(`2026-10-27T${time}:00-04:00`),
  }), /CLEANER_ACCESS_WINDOW_EMPTY/);
});
test("invalid times and offsets fail closed", () => {
  assert.throws(() => defaultCleanerAccessMinutes("24:00", "16:00"));
  assert.throws(() => defaultCleanerAccessMinutes("16:00", "12:00"));
  for (const cleaningStartOffsetMinutes of [-1, NaN, 1.5]) assert.throws(() => planCleanerAccessWindow({
    checkOut: departure, property: { ...property, cleaningStartOffsetMinutes }, nextCheckIn: null,
  }));
});
test("local date boundaries use the property's timezone", () => {
  const w = planCleanerAccessWindow({ checkOut: new Date("2026-10-27T12:00:00+09:00"),
    property: { ...property, timezone: "Asia/Tokyo" }, nextCheckIn: null });
  assert.equal(w.endsAt.toISOString(), "2026-10-27T06:45:00.000Z");
});
test("next occupancy lookup includes overlapping guests and excludes the same/cancelled stay", async () => {
  let query: any;
  const db = { reservation: { findFirst: async (args: any) => { query = args; return { checkIn: new Date("2026-10-27T14:00:00-04:00") }; } } };
  const result = await readCleanerAccessWindow(db as any, { id: "r60", propertyId: "collores", checkOut: departure, property });
  assert.deepEqual(query.where, { propertyId: "collores", id: { not: "r60" }, status: { not: "CANCELLED" }, checkOut: { gt: departure } });
  assert.deepEqual(query.orderBy, { checkIn: "asc" });
  assert.equal(result.endsAt.toISOString(), "2026-10-27T18:00:00.000Z");
});


test("internal Demo Center uses 30-minute cleaner access after the configured offset", async () => {
  let query: any;
  const db = {
    reservation: {
      findFirst: async (args: any) => {
        query = args;
        return null;
      },
    },
  };
  const checkOut = new Date("2026-10-27T11:00:00-04:00");
  const result = await readCleanerAccessWindow(db as any, {
    id: "demo-r1",
    propertyId: "demo-property",
    source: "LODGIFY",
    externalId: "DEMO-1791228000171",
    checkOut,
    property: {
      checkOutTime: "11:00",
      checkInTime: "15:00",
      timezone: "America/Puerto_Rico",
      cleaningStartOffsetMinutes: 15,
    },
  });
  assert.equal(result.startsAt.toISOString(), "2026-10-27T15:15:00.000Z");
  assert.equal(result.endsAt.toISOString(), "2026-10-27T15:45:00.000Z");
  assert.equal(result.durationMinutes, 30);
  assert.equal(query.where.propertyId, "demo-property");
});

test("normal reservations retain the existing cleaner access calculation", async () => {
  const db = { reservation: { findFirst: async () => null } };
  const result = await readCleanerAccessWindow(db as any, {
    id: "normal-r1",
    propertyId: "normal-property",
    source: "DIRECT_BOOKING",
    checkOut: departure,
    property,
  });
  assert.equal(result.startsAt.toISOString(), "2026-10-27T16:45:00.000Z");
  assert.equal(result.endsAt.toISOString(), "2026-10-27T19:45:00.000Z");
  assert.equal(result.durationMinutes, 180);
});
