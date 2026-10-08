import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureCleanerNfcAccessForConfirmedCleaning } from "./cleaner-access-autopilot.service";

function fixture(status = "ACTIVE", unusedWithdrawal = false, programmedWithdrawal = false) {
  const startsAt = new Date("2026-10-27T16:45:00Z");
  const endsAt = new Date("2026-10-27T19:45:00Z");
  const cleaner = { id: "backup", ttlockCardRef: "backup-card" };
  const card: { id: string } | null = { id: "backup-nfc" };
  const grant = { id: "primary-grant", nfcCardId: "primary-nfc", status, startsAt, endsAt,
    retryCount: unusedWithdrawal ? 0 : 1, provisionedAt: null, provisioningStartedAt: null };
  const confirmation = { id: "offer", status: "CONFIRMED", reservationId: "reservation",
    propertyId: "property", staffMemberId: cleaner.id };
  const reservation = { id: "reservation", propertyId: "property", status: "ACTIVE",
    checkOut: new Date("2026-10-27T16:00:00Z"), property: { organizationId: "org",
      cleaningNfcEnabled: true, checkOutTime: "12:00", checkInTime: "16:00",
      timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 45,
      locks: [{ isActive: true, ttlockLockId: "42" }] } };
  const assignmentWrites: unknown[] = [];
  const cardReads: unknown[] = [];
  const audits: Prisma.ApmsAuditEntryCreateInput[] = [];
  const createdGrants: any[] = [];
  let cardResult: { id: string } | null = card;
  const db = {
    cleaningConfirmation: { findUnique: async () => confirmation,
      findMany: async ({ where }: any) => where.status.in?.includes("CONFIRMED")
        ? [confirmation] : (unusedWithdrawal || programmedWithdrawal) ? [{ staffMemberId: "primary" }] : [] },
    reservation: { findUnique: async () => reservation, findFirst: async () => null },
    staffMember: { findUnique: async () => cleaner,
      findMany: async () => [{ ttlockCardRef: "primary-ref" }] },
    staffAssignment: { upsert: async (args: unknown) => { assignmentWrites.push(args); return {}; } },
    nfcAssignment: { findFirst: async ({ where }: any) =>
      typeof where.reservationId === "string" && grant.status !== "ENDED" && (!where.nfcCardId || where.nfcCardId === grant.nfcCardId) ? grant : null,
      updateMany: async ({ where, data }: any) => {
        if (!Object.entries(where).every(([key, value]) => grant[key as keyof typeof grant] === value ||
            key === "cleanerProgrammingAttempts" ||
            (key === "reservationId" && value === "reservation") || (key === "role" && value === "CLEANING"))) return { count: 0 };
        Object.assign(grant, data); return { count: 1 };
      },
      create: async ({ data }: any) => {
        assert.equal(unusedWithdrawal || programmedWithdrawal, true, "Existing-grant validation must not create access");
        createdGrants.push(data); return { id: "backup-grant" };
      },
      update: async () => { throw new Error("Existing-grant validation must not alter access"); } },
    nfcCard: { findFirst: async (args: any) => {
      cardReads.push(args); return args.where.id === "primary-nfc" ? { id: "primary-nfc" } : cardResult;
    } },
    $queryRawUnsafe: async () => [{ id: "reservation" }],
    apmsAuditEntry: { findUnique: async ({ where }: any) => audits.find(row => row.decisionId === where.decisionId) ?? null,
      create: async ({ data }: { data: Prisma.ApmsAuditEntryCreateInput }) => {
      audits.push(data); return data;
    } },
  };
  Object.assign(db, { $transaction: async (run: (tx: typeof db) => unknown) => run(db) });
  return { cleaner, grant, assignmentWrites, cardReads, audits, createdGrants,
    missingCard: () => { cardResult = null; },
    run: () => ensureCleanerNfcAccessForConfirmedCleaning({ prisma: db as unknown as PrismaClient,
      reservationId: "reservation", confirmationId: "offer" }) };
}

for (const status of ["ACTIVE", "SCHEDULED", "PROVISIONING"]) {
  test(`backup cannot inherit readiness from the primary's ${status} card`, async () => {
    const f = fixture(status);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.alreadyReady, false);
    assert.equal(result.reason, "CLEANER_ACCESS_CARD_MISMATCH");
    assert.equal(result.nfcAssignmentId, undefined);
    assert.deepEqual(f.cardReads, [{ where: { propertyId: "property", label: "backup-card" } }]);
    assert.equal(f.audits.at(-1)?.status, "FAILED");
  });
  test(`matching cleaner card preserves existing ${status} access`, async () => {
    const f = fixture(status);
    f.grant.nfcCardId = "backup-nfc";
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.alreadyReady, true);
    assert.equal(result.nfcAssignmentId, "primary-grant");
    assert.equal(f.audits.at(-1)?.status, "SUCCESS");
  });
}

test("matching card still requires the current access window", async () => {
  const f = fixture();
  f.grant.nfcCardId = "backup-nfc";
  f.grant.endsAt = new Date("2026-10-27T20:45:00Z");
  assert.equal((await f.run()).reason, "CLEANER_ACCESS_WINDOW_MISMATCH");
});
test("missing card mapping cannot certify existing access", async () => {
  const f = fixture();
  f.missingCard();
  assert.equal((await f.run()).ok, false);
});
test("missing cleaner card reference cannot certify existing access", async () => {
  const f = fixture();
  f.cleaner.ttlockCardRef = "";
  assert.equal((await f.run()).reason, "CLEANER_ACCESS_CARD_MISMATCH");
  assert.equal(f.cardReads.length, 0);
});

test("withdrawn unused primary grant is retired and backup gets its own SCHEDULED window", async () => {
  const f = fixture("SCHEDULED", true);
  const result = await f.run();
  assert.equal(f.grant.status, "ENDED");
  assert.equal(result.ok, true);
  assert.equal(result.alreadyReady, false);
  assert.equal(result.nfcAssignmentId, "backup-grant");
  assert.equal(f.createdGrants.length, 1);
  assert.equal(f.createdGrants[0].nfcCardId, "backup-nfc");
  assert.equal(f.createdGrants[0].status, "SCHEDULED");
  assert.equal(f.createdGrants[0].startsAt.toISOString(), "2026-10-27T16:45:00.000Z");
  assert.equal(f.createdGrants[0].endsAt.toISOString(), "2026-10-27T19:45:00.000Z");
});

test("accepted backup gets its own scheduled permission while cancelled primary ACTIVE grant keeps its expiry", async () => {
  const f = fixture("ACTIVE", false, true);
  const original = { ...f.grant };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.nfcAssignmentId, "backup-grant");
  assert.equal(result.alreadyReady, false);
  assert.deepEqual(f.grant, original);
  assert.equal(f.createdGrants.length, 1);
  assert.equal(f.createdGrants[0].nfcCardId, "backup-nfc");
  assert.equal(f.createdGrants[0].status, "SCHEDULED");
  assert.equal(f.createdGrants[0].startsAt.getTime(), original.startsAt.getTime());
  assert.equal(f.createdGrants[0].endsAt.getTime(), original.endsAt.getTime());
});

test("accepted backup is scheduled while explicitly cancelled primary programming is in flight", async () => {
  const f = fixture("PROVISIONING", false, true);
  const original = { ...f.grant };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.nfcAssignmentId, "backup-grant");
  assert.equal(f.createdGrants[0].status, "SCHEDULED");
  assert.deepEqual(f.grant, original);
});

test("repeated opening of an already-ready cleaner grant does not duplicate audit evidence or modify access", async () => {
  const f = fixture("SCHEDULED"); f.grant.nfcCardId = "backup-nfc";
  const before = { ...f.grant };
  assert.equal((await f.run()).ok, true);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.audits.length, 1); assert.deepEqual(f.grant, before);
  assert.equal(f.createdGrants.length, 0);
});
