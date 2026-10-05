import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings";
import { createStayTimeDepartureCleaningFixture } from "./stay-time-departure-cleaning.fixture";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service";
import { runIngestTransaction, assertDirectBookingIngestAvailability } from "./direct-booking-ingest-transaction";
import { checkPropertyAvailability } from "./availability.service";
import { changeManualReservationDatesByHost, previewManualReservationDateChangeByHost } from "./manual-reservation-date-change.service";
import { recordChannexAvailabilityConflict } from "./channex-availability-conflict.service";
import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("Direct Booking and canonical Pin AI staging cannot both reserve the cleaning interval", { skip: !url, timeout: 60000 }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const source of ["DIRECT_BOOKING", "MANUAL", "AIRBNB"]) {
  for (const first of (source === "AIRBNB" ? ["booking", "pin-ai", "applied"] : ["booking", "pin-ai"])) await t.test(`${source}: ${first} commits first`, async () => {
    const now = new Date("2026-10-02T12:00Z");
    const org = await db.organization.create({ data: { name: "Synthetic booking race" } });
    const defaults = defaultStayTimeSettings();
    const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic atomic availability",
      timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true,
      cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
      stayTimeSettings: { earlyCheckin: defaults.earlyCheckin, lateCheckout: { ...defaults.lateCheckout, enabled: true } } } });
    const stay = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic current stay",
      guestToken: `synthetic-booking-race-${property.id}`, checkIn: new Date("2026-10-01T19:00Z"),
      checkOut: new Date("2026-10-03T15:00Z"), status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING",
      externalProvider: "PIN_GO_DIRECT", currency: "usd", totalAmount: 150, amountCollected: 150,
      platformFeeAmount: 2.25, hostPayoutAmount: 147.75,
      pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000, nightlySubtotal: 100,
        nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }],
        cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
    const ready = signal(), release = signal();
    let pending: Promise<unknown> | undefined;
    let staffId: string | undefined;
    try {
      const departure = await createStayTimeDepartureCleaningFixture(db, stay, now);
      staffId = departure.staffId;
      const options = { now, platformFeePercent: "1.5" };
      const proposal = await createStayTimeProposal(db, { guestToken: stay.guestToken!, language: "es",
        operation: "LATE_CHECKOUT", requestedLocalTime: "12:30" }, options);
      await confirmStayTimeProposal(db, { guestToken: stay.guestToken!, proposalId: proposal.proposal.id,
        confirmationToken: proposal.confirmationToken! }, options);
      const scope = { guestToken: stay.guestToken!, proposalId: proposal.proposal.id };
      // The incoming stay starts after the extended checkout but during cleaning.
      const incoming = { source, propertyId: property.id,
        checkIn: new Date("2026-10-03T19:59Z"), checkOut: new Date("2026-10-04T15:00Z") };
      let bookingAttempts = 0;
      const book = () => runIngestTransaction(db, source, async tx => {
        bookingAttempts++;
        if (source === "AIRBNB") await checkPropertyAvailability(incoming, tx);
        else await assertDirectBookingIngestAvailability(tx, incoming, null);
        if (first !== "booking" && bookingAttempts === 1) { ready.resolve(); await release.promise; }
        const incomingStay = await tx.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic incoming stay",
          checkIn: incoming.checkIn, checkOut: incoming.checkOut, source, status: "ACTIVE",
          ...(source === "AIRBNB" ? { externalProvider: "CHANNEX" } : {}) } });
        if (source === "AIRBNB") await recordChannexAvailabilityConflict(tx, { reservationId: incomingStay.id, revision: "synthetic-revision" });
        return incomingStay;
      }, source === "AIRBNB" ? "CHANNEX" : undefined);
      let stagingAttempts = 0;
      const stagedDb = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, txOptions: unknown) => {
          stagingAttempts++;
          const attempt = stagingAttempts;
          return db.$transaction(async tx => work(new Proxy(tx, { get(targetTx, txKey) {
            if (txKey !== "reservationModification") return Reflect.get(targetTx, txKey);
            return new Proxy(tx.reservationModification, { get(model, method) {
              if (method !== "create") return Reflect.get(model, method);
              return async (args: Parameters<typeof tx.reservationModification.create>[0]) => {
                if (first === "booking" && attempt === 1) { ready.resolve(); await release.promise; }
                return tx.reservationModification.create(args);
              };
            } });
          } })), txOptions as any);
        };
      } });
      if (first === "booking") {
        pending = stageStayTimeModification(stagedDb, scope, options);
        // Attach immediately so a rejected concurrent transaction is always handled.
        const settled = pending.then(value => ({ value }), error => ({ error }));
        await ready.promise;
        await book();
        release.resolve();
        assert.ok("error" in await settled);
        assert.ok(stagingAttempts >= 2);
      } else {
        pending = book();
        const settled = pending.then(value => ({ value }), error => ({ error }));
        await ready.promise;
        const staged = await stageStayTimeModification(db, scope, options);
        if (first === "applied") await applyGuestReservationModification({ modificationId: staged.modification.id }, {
          client: db, now: () => new Date(now.getTime() + 10_000), reconcile: async () => undefined,
        });
        release.resolve();
        const result = await settled;
        if (source === "AIRBNB") {
          assert.ok("value" in result);
          const issues = await db.operationalIssue.findMany({ where: { propertyId: property.id } });
          assert.equal(issues.length, 1);
          assert.equal(issues[0]!.workflowState, "ACTION_REQUIRED");
          assert.equal(issues[0]!.visibility, "HOST");
          assert.equal(issues[0]!.responsibleActor, "HOST");
          const row = await db.reservation.findFirstOrThrow({ where: { propertyId: property.id, source: "AIRBNB" } });
          await runIngestTransaction(db, source, tx => recordChannexAvailabilityConflict(tx,
            { reservationId: row.id, revision: "synthetic-revision" }), "CHANNEX");
          assert.equal(await db.operationalIssue.count({ where: { propertyId: property.id } }), 1);
          assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issues[0]!.id } }), 1);
        } else {
          assert.ok("error" in result);
          assert.match(String(result.error), source === "MANUAL"
            ? /MANUAL_RESERVATION_DATE_CONFLICT/ : /DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE/);
        }
        assert.ok(bookingAttempts >= 2);
      }
      assert.equal(await db.reservation.count({ where: { propertyId: property.id, guestName: "Synthetic incoming stay" } }), first === "booking" || source === "AIRBNB" ? 1 : 0);
      assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), first !== "booking" ? 1 : 0);
      if (first === "applied") {
        assert.equal((await db.reservationModification.findFirstOrThrow({ where: { reservationId: stay.id } })).status, "APPLIED");
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: stay.id } })).checkOut.toISOString(), "2026-10-03T16:30:00.000Z");
      }
      if (source === "MANUAL" && first === "pin-ai") {
        const manual = await db.reservation.create({ data: { propertyId: property.id, source: "MANUAL", guestName: "Synthetic date change",
          checkIn: new Date("2026-10-05T20:00Z"), checkOut: new Date("2026-10-06T15:00Z"), totalAmount: 100, currency: "usd" } });
        let reconciliations = 0;
        const deps = { prisma: db, checkAvailability: checkPropertyAvailability, now: () => now,
          calculatePricing: async () => ({ totalAmount: 100, currency: "usd" }) as any,
          persistChannexIntent: async () => ({}) as any, reconcile: async () => { reconciliations++; return {} as any; } };
        const dates = { organizationId: org.id, reservationId: manual.id, checkInDate: "2026-10-03", checkOutDate: "2026-10-04" };
        // A persisted hold retains its protected interval even after host settings change.
        await db.property.update({ where: { id: property.id }, data: { checkInTime: "15:59" } });
        await assert.rejects(previewManualReservationDateChangeByHost(dates, deps),
          (error: any) => error.code === "RESERVATION_DATE_CHANGE_CONFLICT");
        assert.equal(reconciliations, 0);
        await db.property.update({ where: { id: property.id }, data: { checkInTime: "16:00" } });
        const preview = await previewManualReservationDateChangeByHost(dates, deps);
        assert.equal(preview.ok, true);
        // A conflict arriving after the preview/prepare must still abort the write.
        let checks = 0;
        const duringCommit = { ...deps, checkAvailability: async (...args: Parameters<typeof checkPropertyAvailability>) => {
          checks++;
          const result = await checkPropertyAvailability(...args);
          if (checks === 1) await db.propertyBlockedDate.create({ data: { propertyId: property.id,
            startDate: new Date("2026-10-03T20:00Z"), endDate: new Date("2026-10-04T15:00Z") } });
          return result;
        } };
        const confirm = { ...dates, requestedByUserId: "synthetic-host", expectedReservationUpdatedAt: manual.updatedAt.toISOString(),
          expectedProposedTotalAmount: 100 };
        await assert.rejects(changeManualReservationDatesByHost(confirm, duringCommit),
          (error: any) => error.code === "RESERVATION_DATE_CHANGE_CONFLICT");
        assert.equal(checks, 2);
        assert.equal(reconciliations, 0);
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: manual.id } })).checkIn.toISOString(), manual.checkIn.toISOString());
        await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
        await changeManualReservationDatesByHost(confirm, deps);
        assert.equal(reconciliations, 1);
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: manual.id } })).checkIn.toISOString(), "2026-10-03T20:00:00.000Z");
      }
    } finally {
      release.resolve();
      if (pending) await pending.catch(() => undefined);
      await db.pinAIActionProposal.deleteMany({ where: { propertyId: property.id } });
      await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
      await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
      await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
      await db.reservation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
      await db.operationalIssueTransition.deleteMany({ where: { issue: { propertyId: property.id } } });
      await db.operationalIssue.deleteMany({ where: { propertyId: property.id } });
      if (staffId) await db.staffMember.delete({ where: { id: staffId } });
      await db.property.delete({ where: { id: property.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
  });
  }
});


test("internal Demo Direct Booking participates in canonical availability serialization", async () => {
  const source = await readFile(
    new URL("./direct-booking-ingest-transaction.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /"DIRECT_BOOKING",\s*"INTERNAL_DEMO_DIRECT_BOOKING",\s*"MANUAL"/
  );
  assert.match(source, /DEMO_RESERVATION_DATE_CONFLICT/);
});
