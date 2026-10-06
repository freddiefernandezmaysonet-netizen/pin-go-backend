import assert from "node:assert/strict";
import test from "node:test";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { guestPinAIAvailability } from "./guest-availability.js";

for (const timezone of ["America/Puerto_Rico", "Asia/Tokyo", "America/New_York"]) {
  test(`24 elapsed hours around the current stay in ${timezone}, including DST`, () => {
    const reservation = { status: "ACTIVE",
      checkIn: fromZonedTime("2026-03-08T15:00:00", timezone),
      checkOut: fromZonedTime("2026-03-10T11:00:00", timezone) };
    const start = reservation.checkIn.getTime() - 86_400_000;
    const end = reservation.checkOut.getTime() + 86_400_000;
    for (const [instant, expected] of [[start - 1, false], [start, true],
      [reservation.checkIn.getTime(), true], [reservation.checkOut.getTime(), true],
      [end - 1, true], [end, false]] as const) {
      assert.equal(guestPinAIAvailability(reservation, new Date(instant)).available, expected);
    }
    if (timezone === "America/New_York") {
      assert.equal(formatInTimeZone(new Date(start), timezone, "yyyy-MM-dd HH:mm"), "2026-03-07 14:00");
    }
  });
}

test("PG64 opens Oct 25 at 15:00 and closes Oct 29 at 11:00 in its property timezone", () => {
  const reservation = { status: "ACTIVE", checkIn: new Date("2026-10-26T15:00:00-04:00"),
    checkOut: new Date("2026-10-28T11:00:00-04:00") };
  const result = guestPinAIAvailability(reservation, new Date("2026-10-06T14:00:00Z"));
  assert.equal(result.available, false);
  assert.equal(result.opensAt?.toISOString(), "2026-10-25T19:00:00.000Z");
  assert.equal(result.closesAt?.toISOString(), "2026-10-29T15:00:00.000Z");
  const now = new Date("2026-10-29T15:30:00Z");
  assert.equal(guestPinAIAvailability(reservation, now).available, false);
  assert.equal(guestPinAIAvailability({ ...reservation, checkOut: new Date("2026-10-28T12:00:00-04:00") }, now).available, true);
  assert.equal(guestPinAIAvailability({ ...reservation, checkIn: new Date("2026-10-07T14:00:00Z") }, new Date("2026-10-06T14:00:00Z")).available, true);
});

test("cancelled reservations and invalid dates fail closed", () => {
  const reservation = { status: "ACTIVE", checkIn: new Date("2026-10-26T19:00:00Z"), checkOut: new Date("2026-10-28T15:00:00Z") };
  const now = reservation.checkIn;
  for (const input of [{ ...reservation, status: "CANCELLED" }, { ...reservation, checkIn: new Date(NaN) },
    { ...reservation, checkOut: reservation.checkIn }]) {
    assert.equal(guestPinAIAvailability(input, now).available, false);
  }
  assert.equal(guestPinAIAvailability(reservation, new Date(NaN)).available, false);
});
