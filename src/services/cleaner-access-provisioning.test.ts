import assert from "node:assert/strict";
import test from "node:test";
import { retryPendingNfcSync } from "./nfc-sync.service";

function fixture(nextCheckIn: Date | null) {
  const now = new Date("2026-10-27T15:00:00Z");
  const updates: any[] = [], hardware: any[] = [];
  const row = { id: "nfc", reservationId: "r60", nfcCardId: "card", role: "CLEANING", status: "SCHEDULED",
    retryCount: 0, updatedAt: now, startsAt: new Date("2026-10-27T16:45:00Z"), endsAt: new Date("2026-10-27T20:45:00Z"),
    NfcCard: { ttlockCardId: "123", status: "ASSIGNED" },
    Reservation: { id: "r60", status: "ACTIVE", propertyId: "collores", checkOut: new Date("2026-10-27T16:00:00Z"),
      property: { organizationId: "org", checkOutTime: "12:00", checkInTime: "16:00", timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 45 } } };
  const db: any = { reservation: { findFirst: async () => nextCheckIn ? { checkIn: nextCheckIn } : null },
    nfcAssignment: { findMany: async () => [row], updateMany: async () => ({ count: 1 }),
      findFirst: async () => null, update: async ({ data }: any) => { updates.push(data); return {}; } },
    nfcCard: { update: async () => ({}) }, lock: { findFirst: async () => ({ ttlockLockId: 42 }) },
    $transaction: async (actions: any[]) => Promise.all(actions) };
  let failure = false;
  const dependencies = { getAccessToken: async () => "test", reconcileIssues: async () => {},
    changeCardPeriod: async (args: any) => { hardware.push(args); if (failure) throw new Error("gateway offline"); return {}; } };
  return { now, row, db, dependencies, updates, hardware, fail: () => { failure = true; } };
}
test("a stale 16:45 cleaner assignment is programmed and persisted as 15:45", async () => {
  const f = fixture(null);
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 1);
  assert.equal(f.hardware[0].endDate, Date.parse("2026-10-27T19:45:00Z"));
  assert.equal(f.updates.find(x => x.status === "ACTIVE").endsAt.toISOString(), "2026-10-27T19:45:00.000Z");
});
test("new early check-in is re-read before programming", async () => {
  const f = fixture(new Date("2026-10-27T18:00:00Z"));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware[0].endDate, Date.parse("2026-10-27T18:00:00Z"));
});
test("no available window causes no hardware grant and no ACTIVE receipt", async () => {
  const f = fixture(new Date("2026-10-27T16:30:00Z"));
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.hardware.length, 0);
  assert.equal(f.updates.some(x => x.status === "ACTIVE"), false);
  assert.match(f.updates.at(-1).lastError, /WINDOW_EMPTY/);
});
test("failed hardware change never acknowledges a repaired window", async () => {
  const f = fixture(null); f.fail();
  await retryPendingNfcSync(f.db, f.now, {}, f.dependencies);
  assert.equal(f.updates.some(x => x.status === "ACTIVE" || x.endsAt), false);
  assert.equal(f.updates.at(-1).status, "FAILED");
});
