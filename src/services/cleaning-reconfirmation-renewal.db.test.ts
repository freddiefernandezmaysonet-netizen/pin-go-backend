import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { renewCleaningConfirmation } from "./cleaning-reconfirmation-renewal.service.js";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";
import { acceptCleaningTimingConsent } from "./cleaning-timing-consent.prisma.js";
import { createCleaningWorkSnapshotStore } from "./cleaning-work-snapshot.prisma.js";
import { materializeCleaningWorkSnapshot } from "./cleaning-work-snapshot.service.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("cleaning renewal commits history, confirmation and reconciliation atomically", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const scenario of ["concurrent", "rollback", "started", "completed", "staff-disabled", "date-changed", "scope", "start-race"] as const) {
    await t.test(scenario, async () => {
      const now = new Date("2026-10-01T12:00Z");
      const org = await db.organization.create({ data: { name: "Synthetic renewal" } });
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic renewal", cleaningNfcEnabled: true,
        cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180 } });
      const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner", phoneE164: "+15555550100" } });
      const reservation = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic renewal",
        checkIn: new Date("2026-09-30T19:00Z"), checkOut: new Date("2026-10-02T17:00Z"),
        lastReconciledCheckIn: new Date("2026-09-30T19:00Z"), lastReconciledCheckOut: new Date("2026-10-02T15:00Z") } });
      try {
        await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY", cleaningDurationCommitmentMinutes: 120 } });
        const old = await db.cleaningConfirmation.create({ data: { reservationId: reservation.id, propertyId: property.id,
          staffMemberId: staff.id, token: `synthetic-renewal-${reservation.id}`, status: "CONFIRMED" } });
        const work = await db.cleaningWork.create({ data: { reservationId: reservation.id, propertyId: property.id, staffMemberId: staff.id,
          confirmationId: old.id, scheduledStartAt: new Date("2026-10-02T15:30Z"), durationCommitmentMinutes: 120,
          startConfirmationGraceMinutes: 30, followupGraceMinutes: 15, timingConsentVersion: "old-consent", timingConsentAcceptedAt: now,
          ...(scenario === "started" || scenario === "completed" ? { startConfirmedAt: now } : {}),
          ...(scenario === "completed" ? { completionConfirmedAt: now } : {}),
        } });
        const input = { reservationId: reservation.id, propertyId: property.id, organizationId: org.id,
          checkIn: reservation.checkIn, checkOut: reservation.checkOut, expectedLastReconciledAt: null,
          previousConfirmationId: old.id, staffMemberId: staff.id, cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180 };
        const declaration = { workId: work.id, reservationId: reservation.id, staffMemberId: staff.id, confirmationId: old.id };
        if (scenario === "staff-disabled") await db.staffMember.update({ where: { id: staff.id }, data: { isActive: false } });
        if (scenario === "date-changed") input.checkOut = new Date("2026-10-02T18:00Z");
        if (scenario === "scope") input.organizationId = "wrong-organization";
        if (scenario === "start-race") {
          const results = await Promise.allSettled([
            renewCleaningConfirmation(db, input, now), confirmCleaningStart(db, declaration, now),
          ]);
          assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
          const current = await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } });
          assert.notEqual(Boolean(current.supersededAt), Boolean(current.startConfirmedAt));
          return;
        }
        if (scenario === "rollback") {
          const failing = { $transaction: (async (run: any, options: any) => db.$transaction(async tx => {
            await run(tx); throw new Error("FORCED_RENEWAL_ROLLBACK");
          }, options)) as typeof db.$transaction };
          await assert.rejects(renewCleaningConfirmation(failing, input, now), /FORCED_RENEWAL_ROLLBACK/);
        } else if (scenario !== "concurrent") {
          await assert.rejects(renewCleaningConfirmation(db, input, now), /CLEANING_RENEWAL_/);
        } else {
          const results = await Promise.all([renewCleaningConfirmation(db, input, now), renewCleaningConfirmation(db, input, now)]);
          assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
          assert.equal((await renewCleaningConfirmation(db, input, now)).replayed, true);
          const history = await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } });
          assert.deepEqual({ ...history, supersededAt: work.supersededAt, updatedAt: work.updatedAt }, work);
          assert.equal(history.supersededAt?.getTime(), now.getTime());
          assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: old.id } })).status, "EXPIRED");
          assert.equal(await db.cleaningConfirmation.count({ where: { reservationId: reservation.id } }), 2);
          const next = await db.cleaningConfirmation.findFirstOrThrow({ where: { reservationId: reservation.id, status: "PENDING" } });
          await assert.rejects(confirmCleaningStart(db, declaration, now), /WORK_CLOSED/);
          await assert.rejects(acceptCleaningTimingConsent(db, declaration, now), /WORK_CLOSED/);
          const scope = { organizationId: org.id, propertyId: property.id, reservationId: reservation.id, staffMemberId: staff.id, confirmationId: next.id };
          const store = createCleaningWorkSnapshotStore(db);
          await assert.rejects(materializeCleaningWorkSnapshot(store, scope, now), /CONFIRMATION_REQUIRED/);
          await db.cleaningConfirmation.update({ where: { id: next.id }, data: { status: "CONFIRMED" } });
          const created = await materializeCleaningWorkSnapshot(store, scope, now);
          assert.equal(created.work?.scheduledStartAt.toISOString(), "2026-10-02T17:30:00.000Z");
          assert.equal(created.work?.timingConsentAcceptedAt, null);
          assert.notEqual(created.work?.id, work.id);
          assert.equal(await db.cleaningWork.count({ where: { reservationId: reservation.id } }), 2);
          return;
        }
        assert.deepEqual(await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } }), work);
        assert.equal(await db.cleaningConfirmation.count({ where: { reservationId: reservation.id } }), 1);
        assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: old.id } })).status, "CONFIRMED");
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).lastReconciledAt, null);
      } finally {
        await db.cleaningWork.deleteMany({ where: { reservationId: reservation.id } });
        await db.cleaningConfirmation.deleteMany({ where: { reservationId: reservation.id } });
        await db.reservation.delete({ where: { id: reservation.id } });
        await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
        await db.staffMember.delete({ where: { id: staff.id } });
        await db.property.delete({ where: { id: property.id } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
