import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings";
import { createStayTimeDepartureCleaningFixture } from "./stay-time-departure-cleaning.fixture";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service";
import { runIngestTransaction, assertDirectBookingIngestAvailability } from "./direct-booking-ingest-transaction";

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
  for (const first of ["booking", "pin-ai"] as const) await t.test(`${first} commits first`, async () => {
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
      const incoming = { source: "DIRECT_BOOKING", propertyId: property.id,
        checkIn: new Date("2026-10-03T19:59Z"), checkOut: new Date("2026-10-04T15:00Z") };
      let bookingAttempts = 0;
      const book = () => runIngestTransaction(db, "DIRECT_BOOKING", async tx => {
        bookingAttempts++;
        await assertDirectBookingIngestAvailability(tx, incoming, null);
        if (first === "pin-ai" && bookingAttempts === 1) { ready.resolve(); await release.promise; }
        return tx.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic incoming stay",
          checkIn: incoming.checkIn, checkOut: incoming.checkOut, source: "DIRECT_BOOKING", status: "ACTIVE" } });
      });
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
        await stageStayTimeModification(db, scope, options);
        release.resolve();
        const result = await settled;
        assert.ok("error" in result);
        assert.match(String(result.error), /DIRECT_BOOKING_PROPERTY_NO_LONGER_AVAILABLE/);
        assert.ok(bookingAttempts >= 2);
      }
      assert.equal(await db.reservation.count({ where: { propertyId: property.id, guestName: "Synthetic incoming stay" } }), first === "booking" ? 1 : 0);
      assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), first === "pin-ai" ? 1 : 0);
    } finally {
      release.resolve();
      if (pending) await pending.catch(() => undefined);
      await db.pinAIActionProposal.deleteMany({ where: { propertyId: property.id } });
      await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
      await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
      await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
      await db.reservation.deleteMany({ where: { propertyId: property.id } });
      if (staffId) await db.staffMember.delete({ where: { id: staffId } });
      await db.property.delete({ where: { id: property.id } });
      await db.organization.delete({ where: { id: org.id } });
    }
  });
});
