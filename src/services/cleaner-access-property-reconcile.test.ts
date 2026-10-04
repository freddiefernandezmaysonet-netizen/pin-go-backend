import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePropertyCleanerAccess } from "./cleaner-access-property-reconcile.service";

function fixture(status: "ACTIVE" | "SCHEDULED" = "ACTIVE") {
  const now = new Date("2026-10-27T16:00:00Z"), calls: string[] = [], writes: any[] = [];
  const row = { id: "a", reservationId: "r60", status, updatedAt: now,
    startsAt: new Date("2026-10-27T16:45:00Z"), endsAt: new Date("2026-10-27T20:45:00Z"),
    NfcCard: { ttlockCardId: "1" }, Reservation: { id: "r60", propertyId: "p", checkOut: now,
      property: { timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "12:00",
        cleaningStartOffsetMinutes: 45, locks: [{ isActive: true, ttlockLockId: 2 }] } } };
  let next = new Date("2026-10-27T18:00:00Z"), error: Error | null = null, readError = false, claim = true;
  const db: any = {
    reservation: { findFirst: async () => { if (readError) throw new Error("database unavailable"); return { checkIn: next }; } },
    nfcAssignment: { findMany: async () => [row], updateMany: async () => { calls.push("claim"); return { count: claim ? 1 : 0 }; },
      update: async ({data}: any) => { calls.push("persist"); writes.push(data); } },
    staffAssignment: { updateMany: async () => { calls.push("staff"); } },
  };
  const deps = { now: () => now, changeCardPeriod: async (args: any) => {
    calls.push("hardware"); if (error) throw error;
    assert.ok(args.endDate <= next.getTime()); return {};
  } };
  return { db, deps, row, calls, writes, setEmpty: () => { next = new Date("2026-10-27T16:30:00Z"); },
    fail: () => { error = new Error("offline"); }, failRead: () => { readError = true; }, loseClaim: () => { claim = false; } };
}
test("arrival change repairs ACTIVE cleaner hardware before acknowledging the new window", async () => {
  const f = fixture(); await reconcilePropertyCleanerAccess(f.db, "p", f.deps);
  assert.deepEqual(f.calls, ["claim", "hardware", "persist", "staff"]);
  assert.equal(f.writes[0].endsAt.toISOString(), "2026-10-27T18:00:00.000Z");
});
test("SCHEDULED cleaner repair does not call hardware", async () => {
  const f = fixture("SCHEDULED"); await reconcilePropertyCleanerAccess(f.db, "p", f.deps);
  assert.deepEqual(f.calls, ["claim", "persist", "staff"]);
});
test("empty window revokes hardware, closes the assignment and surfaces a conflict", async () => {
  const f = fixture(); f.setEmpty();
  await assert.rejects(reconcilePropertyCleanerAccess(f.db, "p", f.deps), /REVIEW_REQUIRED/);
  assert.equal(f.writes[0].status, "ENDED");
  assert.deepEqual(f.calls, ["claim", "hardware", "persist", "staff"]);
});
test("failed provider change keeps previous active receipt and surfaces recovery failure", async () => {
  const f = fixture(); f.fail();
  await assert.rejects(reconcilePropertyCleanerAccess(f.db, "p", f.deps), /offline/);
  assert.equal(f.writes[0].status, "ACTIVE");
  assert.equal(f.writes[0].endsAt, undefined);
});
test("database failure or lost claim cannot mutate physical access", async () => {
  for (const fail of ["failRead", "loseClaim"] as const) {
    const f = fixture(); f[fail](); await assert.rejects(reconcilePropertyCleanerAccess(f.db, "p", f.deps));
    assert.equal(f.calls.includes("hardware"), false);
  }
});
