import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { retireUnusedWithdrawnCleanerGrant } from "./cleaner-unused-grant.service";

function fixture() {
  const input = { reservationId: "r", propertyId: "p", confirmationId: "backup",
    grantId: "old", grantCardId: "primary-card", replacementCardId: "backup-card" };
  const row = { id: "old", reservationId: "r", nfcCardId: "primary-card", role: "CLEANING",
    status: "SCHEDULED", retryCount: 0, provisioningStartedAt: null as Date | null,
    provisionedAt: null as Date | null };
  let current = [{ id: "backup", propertyId: "p", status: "CONFIRMED" }];
  let withdrawn = [{ staffMemberId: "primary" }];
  let matchesFormerCard = true;
  let competingWorker = false;
  let hasProgrammingEvidence = false;
  const writes: unknown[] = [], locks: unknown[] = [];
  const tx = {
    $queryRawUnsafe: async (...args: unknown[]) => { locks.push(args); return [{ id: "r" }]; },
    cleaningConfirmation: { findMany: async (args: any) =>
      args.where.status.in.includes("CONFIRMED") ? current : withdrawn },
    staffMember: { findMany: async () => [{ ttlockCardRef: "primary-ref" }] },
    nfcCard: { findFirst: async (args: any) => {
      assert.equal(args.where.id, input.grantCardId);
      assert.equal(args.where.propertyId, "p");
      assert.deepEqual(args.where.label.in, ["primary-ref"]);
      return matchesFormerCard ? { id: "primary-card" } : null;
    } },
    nfcAssignment: { updateMany: async (args: any) => {
      if (competingWorker) { row.status = "PROVISIONING"; row.retryCount = 1; }
      if (!Object.entries(args.where).every(([key, value]) => key === "cleanerProgrammingAttempts"
        ? !hasProgrammingEvidence : row[key as keyof typeof row] === value)) return { count: 0 };
      writes.push(args); Object.assign(row, args.data); return { count: 1 };
    } },
  };
  const db = { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) };
  return { input, row, writes, locks,
    setCurrent: (offers: typeof current) => { current = offers; },
    clearWithdrawal: () => { withdrawn = []; },
    wrongFormerCard: () => { matchesFormerCard = false; },
    claimByWorker: () => { competingWorker = true; },
    addProgrammingEvidence: () => { hasProgrammingEvidence = true; },
    run: () => retireUnusedWithdrawnCleanerGrant(db as unknown as PrismaClient, input) };
}

test("unused withdrawn grant retires once under the reservation lock", async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.equal(f.row.status, "ENDED");
  assert.equal(f.writes.length, 1);
  assert.match(String(f.locks[0]), /FOR UPDATE/);
  assert.equal(await f.run(), false);
  assert.equal(f.writes.length, 1);
});
for (const state of ["ACTIVE", "PROVISIONING", "FAILED", "ENDED"]) {
  test(`${state} grant cannot be retired as unused`, async () => {
    const f = fixture(); f.row.status = state;
    assert.equal(await f.run(), false);
    assert.equal(f.writes.length, 0);
  });
}
test("scheduled grant with previous attempt remains for physical reconciliation", async () => {
  const f = fixture(); f.row.retryCount = 1;
  assert.equal(await f.run(), false);
});
test("scheduled grant with provider evidence cannot be retired as unused", async () => {
  const f = fixture(); f.row.provisionedAt = new Date();
  assert.equal(await f.run(), false);
});
test("worker claiming first prevents unused retirement", async () => {
  const f = fixture(); f.claimByWorker();
  assert.equal(await f.run(), false);
  assert.equal(f.row.status, "PROVISIONING");
  assert.equal(f.writes.length, 0);
});
test("withdrawal must be established, not inferred from card mismatch", async () => {
  const f = fixture(); f.clearWithdrawal();
  assert.equal(await f.run(), false);
});
test("former cleaner must map to the exact card on the same property", async () => {
  const f = fixture(); f.wrongFormerCard();
  assert.equal(await f.run(), false);
});
test("shared card is not a distinct replacement permission", async () => {
  const f = fixture(); f.input.replacementCardId = f.input.grantCardId;
  assert.equal(await f.run(), false);
  assert.equal(f.locks.length, 0);
});
test("cancelled backup cannot authorize unused grant retirement", async () => {
  const f = fixture(); f.setCurrent([]);
  assert.equal(await f.run(), false);
});
test("competing current offers prevent retirement", async () => {
  const f = fixture(); f.setCurrent([{ id: "backup", propertyId: "p", status: "CONFIRMED" },
    { id: "other", propertyId: "p", status: "PENDING" }]);
  assert.equal(await f.run(), false);
});
test("durable programming evidence prevents unused retirement even with zero counter", async () => {
  const f = fixture(); f.addProgrammingEvidence();
  assert.equal(await f.run(), false);
  assert.equal(f.writes.length, 0);
});
