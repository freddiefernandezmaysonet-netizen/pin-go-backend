import assert from "node:assert/strict";
import test from "node:test";
import { checkPropertyAvailability, getPropertyBlockedDateKeys } from "./availability.service.js";
import { createStayTimeDepartureCleaningFixture } from "./stay-time-departure-cleaning.fixture.js";
import { Prisma, PrismaClient } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service.js";
import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("free stay-time changes apply atomically through the canonical service", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const scenario of ["late", "early", "cleaning-revoked", "cleaning-buffer-blocked", "reservation-changed",
    "expired", "pricing-tampered", "reconcile-retry", "transaction-retry", "first-lock-retry", "paid-blocked"] as const) {
    await t.test(scenario, async t => {
      const early = scenario === "early" || scenario === "cleaning-revoked";
      const now = new Date(early ? "2026-10-01T12:00Z" : "2026-10-02T12:00Z");
      const org = await db.organization.create({ data: { name: "Synthetic stay-time apply" } });
      const defaults = defaultStayTimeSettings();
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic free apply",
        timezone: "America/Puerto_Rico", checkInTime: early ? "15:00" : "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true,
        cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
        stayTimeSettings: { earlyCheckin: { ...defaults.earlyCheckin, enabled: true },
          lateCheckout: { ...defaults.lateCheckout, enabled: true,
            ...(scenario === "paid-blocked" ? { fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } } : {}) } } } });
      const stay = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic apply guest",
        guestToken: `synthetic-apply-${property.id}`, checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
        status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
        currency: "usd", totalAmount: 150, amountCollected: 150, platformFeeAmount: 2.25, hostPayoutAmount: 147.75,
        pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000,
          nightlySubtotal: 100, nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }],
          cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
      let staffId: string | undefined;
      let workId: string | undefined;
      try {
        if (!early) {
          const departure = await createStayTimeDepartureCleaningFixture(db, stay, now);
          staffId = departure.staffId;
          workId = departure.workId;
        }
        if (early) {
          const prior = await db.reservation.create({ data: { propertyId: property.id, guestName: "Prior synthetic guest",
            checkIn: new Date("2026-09-29T19:00Z"), checkOut: new Date("2026-10-01T10:00Z") } });
          const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner" } });
          staffId = staff.id;
          await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY" } });
          const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: prior.id, propertyId: property.id,
            staffMemberId: staff.id, status: "CONFIRMED", token: `synthetic-apply-${staff.id}` } });
          const work = await db.cleaningWork.create({ data: { reservationId: prior.id, propertyId: property.id,
            staffMemberId: staff.id, confirmationId: confirmation.id, scheduledStartAt: new Date("2026-10-01T10:30Z"),
            durationCommitmentMinutes: 30, startConfirmationGraceMinutes: 5, followupGraceMinutes: 5,
            timingConsentVersion: "v1", timingConsentAcceptedAt: new Date("2026-09-29T15:00Z"),
            startConfirmedAt: new Date("2026-10-01T10:30Z"), completionConfirmedAt: new Date("2026-10-01T11:00Z") } });
          workId = work.id;
        }
        const options = { now, platformFeePercent: "1.5" };
        const proposal = await createStayTimeProposal(db, { guestToken: stay.guestToken!, language: "es",
          operation: early ? "EARLY_CHECKIN" : "LATE_CHECKOUT", requestedLocalTime: early ? "12:00" : "12:30" }, options);
        await confirmStayTimeProposal(db, { guestToken: stay.guestToken!, proposalId: proposal.proposal.id,
          confirmationToken: proposal.confirmationToken }, options);
        const staged = await stageStayTimeModification(db, { guestToken: stay.guestToken!, proposalId: proposal.proposal.id }, options);
        const id = staged.modification.id;
        if (scenario === "late") await t.test("general availability retains applying holds and releases terminal/expired changes", async () => {
          const interval = { propertyId: property.id, checkIn: stay.checkOut,
            checkOut: new Date(staged.modification.proposedCheckOut.getTime() + 60_000) };
          const calendar = { propertyId: property.id, from: stay.checkIn,
            to: new Date("2026-10-04T20:00Z"), excludeReservationId: stay.id };
          for (const status of ["APPLYING", "PAYMENT_PROCESSING"] as const) {
            await db.reservationModification.update({ where: { id }, data: { status, checkoutExpiresAt: null } });
            const result = await checkPropertyAvailability(interval, db);
            assert.equal(result.available, false);
            assert.equal(result.conflict?.type, "RESERVATION_MODIFICATION_HOLD");
            assert.equal(result.conflict?.id, id);
            const dates = await getPropertyBlockedDateKeys(calendar, db);
            assert.deepEqual(dates.modificationHolds.map(row => row.id), [id]);
            assert.deepEqual(dates.blockedDates, ["2026-10-01", "2026-10-02"]);
            assert.equal((await checkPropertyAvailability({ ...interval, excludeReservationModificationId: id }, db)).available, true);
            assert.deepEqual((await getPropertyBlockedDateKeys({ ...calendar, excludeReservationModificationId: id }, db)).blockedDates, []);
            const turnover = { propertyId: property.id, checkIn: staged.modification.proposedCheckOut,
              checkOut: new Date("2026-10-04T15:00Z") };
            const blockedTurnover = await checkPropertyAvailability(turnover, db);
            assert.equal(blockedTurnover.available, false);
            assert.equal(blockedTurnover.conflict?.type, "STAY_TIME_TURNOVER_HOLD");
            assert.equal((await checkPropertyAvailability({ ...turnover, excludeReservationModificationId: id }, db)).available, true);
            // The exact completion boundary (16:00 local) preserves the next night.
            assert.equal((await checkPropertyAvailability({ ...turnover,
              checkIn: new Date("2026-10-03T20:00Z") }, db)).available, true);
            const otherProperty = await db.property.create({ data: { organizationId: org.id, name: "Other synthetic property" } });
            try { assert.equal((await checkPropertyAvailability({ ...interval, propertyId: otherProperty.id }, db)).available, true); }
            finally { await db.property.delete({ where: { id: otherProperty.id } }); }
          }
          for (const status of ["CANCELLED", "EXPIRED", "APPLIED", "AWAITING_PAYMENT"] as const) {
            await db.reservationModification.update({ where: { id }, data: { status,
              checkoutExpiresAt: new Date(Date.now() - 60_000) } });
            assert.equal((await checkPropertyAvailability(interval, db)).available, true);
            assert.deepEqual((await getPropertyBlockedDateKeys(calendar, db)).blockedDates, []);
          }
          await db.reservationModification.update({ where: { id }, data: { status: "AWAITING_PAYMENT",
            checkoutExpiresAt: new Date(Date.now() + 60_000) } });
          assert.equal((await checkPropertyAvailability(interval, db)).available, false);
          assert.deepEqual((await getPropertyBlockedDateKeys(calendar, db)).modificationHolds.map(row => row.id), [id]);
          await db.reservationModification.update({ where: { id }, data: { status: "APPLYING", checkoutExpiresAt: null } });
        });
        if (scenario === "cleaning-revoked") await db.cleaningWork.update({ where: { id: workId! }, data: { completionConfirmedAt: null } });
        if (scenario === "cleaning-buffer-blocked") await db.propertyBlockedDate.create({ data: { propertyId: property.id,
          startDate: new Date("2026-10-03T19:59Z"), endDate: new Date("2026-10-04T15:00Z") } });
        if (scenario === "reservation-changed") await db.reservation.update({ where: { id: stay.id }, data: { guestName: "Material change" } });
        if (scenario === "pricing-tampered") await db.reservationModification.update({ where: { id }, data: {
          proposedPricing: { ...(staged.modification.proposedPricing as object), cleaningFee: 999 },
        } });
        if (scenario === "paid-blocked") await db.reservationModification.update({ where: { id }, data: { status: "APPLYING" } });
        const before = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
        const reconciled: string[] = [];
        let transactionAttempts = 0;
        const retryClient = { reservationModification: db.reservationModification,
          $transaction: (async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => {
            transactionAttempts++;
            if (scenario === "first-lock-retry" && transactionAttempts === 1) throw new Prisma.PrismaClientKnownRequestError("Synthetic first-lock serialization conflict", {
              code: "P2010", clientVersion: "synthetic-test", meta: { code: "40001" },
            });
            return db.$transaction(async tx => {
              const result = await callback(tx);
              // Abort after the writes but before commit: retry must not duplicate them.
              if (transactionAttempts === 1) throw new Prisma.PrismaClientKnownRequestError("Synthetic serialization conflict", {
                code: "P2034", clientVersion: "synthetic-test",
              });
              return result;
            }, options);
          }) as typeof db.$transaction };
        const dependencies = { client: scenario === "transaction-retry" || scenario === "first-lock-retry" ? retryClient : db, now: () => new Date(now.getTime() + (scenario === "expired" ? 60_000 : 10_000)),
          reconcile: async (reservationId: string) => {
            reconciled.push(reservationId);
            if (scenario === "reconcile-retry" && reconciled.length === 1) throw new Error("Synthetic reconcile outage");
          } };
        const success = ["late", "early", "reconcile-retry", "transaction-retry", "first-lock-retry"].includes(scenario);
        if (!success) {
          const code = scenario === "cleaning-revoked" ? "ARRIVAL_READINESS_REQUIRED" : scenario === "cleaning-buffer-blocked" ? "TURNOVER_CONFLICT"
            : scenario === "reservation-changed" ? "STAY_TIME_QUOTE_CHANGED" : scenario === "expired" ? "STAY_TIME_QUOTE_EXPIRED"
            : scenario === "paid-blocked" ? "STAY_TIME_PAYMENT_APPLY_NOT_READY" : "STAY_TIME_MODIFICATION_TERMS_MISMATCH";
          await assert.rejects(applyGuestReservationModification({ modificationId: id }, dependencies), (error: unknown) => (error as { code?: string }).code === code);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), before);
          const failed = await db.reservationModification.findUniqueOrThrow({ where: { id } });
          assert.equal(failed.status, scenario === "paid-blocked" ? "APPLYING" : "CANCELLED");
          assert.equal(failed.failureCode, code);
          assert.equal(failed.appliedAt, null);
          assert.deepEqual(reconciled, []);
        } else {
          if (scenario === "reconcile-retry") await assert.rejects(applyGuestReservationModification({ modificationId: id }, dependencies), /Synthetic reconcile outage/);
          else await applyGuestReservationModification({ modificationId: id }, dependencies);
          const applied = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
          assert.equal(applied.checkIn.toISOString(), early ? "2026-10-01T16:00:00.000Z" : before.checkIn.toISOString());
          assert.equal(applied.checkOut.toISOString(), early ? before.checkOut.toISOString() : "2026-10-03T16:30:00.000Z");
          assert.equal(applied.totalAmount?.toString(), "150");
          assert.equal(applied.amountCollected?.toString(), "150");
          assert.equal(applied.platformFeeAmount?.toString(), "2.25");
          assert.equal(applied.hostPayoutAmount?.toString(), "147.75");
          assert.equal(applied.lastReconciledCheckIn?.toISOString(), before.checkIn.toISOString());
          assert.equal(applied.lastReconciledCheckOut?.toISOString(), before.checkOut.toISOString());
          assert.equal(applied.lastHardwareSyncAt, null);
          assert.equal((await db.reservationModification.findUniqueOrThrow({ where: { id } })).status, "APPLIED");
          if (scenario === "late") await t.test("applied late checkout retains its promised turnover without blocking the next night", async () => {
            const turnover = { propertyId: property.id, checkIn: applied.checkOut, checkOut: new Date("2026-10-04T15:00Z") };
            const held = await checkPropertyAvailability(turnover, db);
            assert.equal(held.available, false);
            assert.equal(held.conflict?.type, "STAY_TIME_TURNOVER_HOLD");
            assert.equal((await checkPropertyAvailability({ ...turnover, checkIn: new Date("2026-10-03T19:59Z") }, db)).available, false);
            assert.equal((await checkPropertyAvailability({ ...turnover, checkIn: new Date("2026-10-03T20:00Z") }, db)).available, true);
            const dates = await getPropertyBlockedDateKeys({ propertyId: property.id,
              from: new Date("2026-10-03T20:00Z"), to: turnover.checkOut }, db);
            assert.deepEqual(dates.blockedDates, []);
            const saved = await db.reservationModification.findUniqueOrThrow({ where: { id } });
            const consent = saved.guestConfirmation as Prisma.JsonObject;
            await db.reservationModification.update({ where: { id }, data: { guestConfirmation: {
              ...consent, quoteTerms: { ...(consent.quoteTerms as Prisma.JsonObject), requiredFreeUntil: "corrupt" },
            } } });
            await assert.rejects(checkPropertyAvailability(turnover, db), /STAY_TIME_TURNOVER_REQUIRES_REVIEW/);
            await db.reservationModification.update({ where: { id }, data: { guestConfirmation: consent } });
            await db.reservation.update({ where: { id: stay.id }, data: { status: "CANCELLED" } });
            assert.equal((await checkPropertyAvailability(turnover, db)).available, true);
            await db.reservation.update({ where: { id: stay.id }, data: { status: "ACTIVE", updatedAt: applied.updatedAt } });
          });
          const replay = await applyGuestReservationModification({ modificationId: id }, dependencies);
          assert.equal(replay.idempotentReplay, true);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), applied);
          assert.deepEqual(reconciled, [stay.id, stay.id]);
          assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 1);
          if (scenario === "transaction-retry" || scenario === "first-lock-retry") assert.equal(transactionAttempts, 3); // failed tx, retry, idempotent replay
        }
      } finally {
        await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
        await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
        if (staffId) await db.staffMember.delete({ where: { id: staffId } });
        await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
        await db.pinAIActionProposal.deleteMany({ where: { propertyId: property.id } });
        await db.reservation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
        await db.property.delete({ where: { id: property.id } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
