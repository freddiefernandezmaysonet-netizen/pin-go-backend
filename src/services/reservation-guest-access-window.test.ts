import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { guestAccessWindow } from "./reservation-guest-access-window";

const date = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));

for (const scenario of [
  { name: "early check-in only", start: 13, end: 20, changed: true },
  { name: "late checkout only", start: 15, end: 22, changed: true },
  { name: "both boundaries", start: 13, end: 22, changed: true },
  { name: "unchanged timestamps in new Date objects", start: 15, end: 20, changed: false },
  { name: "shortened access", start: 16, end: 19, changed: true },
]) {
  test(`guest access window: ${scenario.name}`, () => {
    const current = { startsAt: date(15), endsAt: date(20) };
    const reservation = { checkIn: date(scenario.start), checkOut: date(scenario.end) };
    const next = guestAccessWindow(current, reservation);
    assert.equal(next.changed, scenario.changed);
    assert.equal(next.startsAt.getTime(), reservation.checkIn.getTime());
    assert.equal(next.endsAt.getTime(), reservation.checkOut.getTime());
    assert.equal(current.startsAt.getTime(), date(15).getTime());
    assert.equal(current.endsAt.getTime(), date(20).getTime());
  });
}

test("NFC detection and application share the complete guest window", async () => {
  const source = await readFile(new URL("./reservation.reconcile.service.ts", import.meta.url), "utf8");
  assert.match(source, /if \(a.role === NfcAssignmentRole.GUEST\) \{\s*return guestAccessWindow\(a, reservation\).changed;/);
  assert.match(source, /const next = guestAccessWindow\(a, reservation\);/);
  assert.match(source, /startDate: next.startsAt.getTime\(\),\s*endDate: next.endsAt.getTime\(\)/);
  assert.doesNotMatch(source, /startsAt: a.startsAt/);
});
