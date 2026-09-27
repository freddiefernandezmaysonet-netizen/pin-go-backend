import { applyGuestReservationModification } from "./guest-reservation-modification-apply.service.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { confirmGuestReservationModification, getGuestReservationModificationPreview } from "./guest-reservation-modification.service.js";

const TEST_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pingo_pin_ai_extension_test";

test("in-stay confirmation concurrency in disposable PostgreSQL", async t => {
  assert.equal(process.env.PIN_AI_EXTENSION_TEST_DATABASE_URL, TEST_URL, "Refusing non-disposable database");
  assert.equal(process.env.DATABASE_URL, TEST_URL, "Default client must also target the disposable database");
  const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  t.after(() => db.$disconnect());
  assert.equal(await db.organization.count(), 0, "Use an empty database; never reset existing records");
  assert.equal(await db.reservation.count(), 0);
  assert.equal(await db.reservationModification.count(), 0);
  const now = new Date("2026-09-26T22:00:00Z");
  let sequence = 0;

  async function fixture(concurrent = true) {
    const key = `synthetic-extension-${++sequence}`;
    const org = await db.organization.create({ data: { name: key } });
    const property = await db.property.create({ data: {
      name: key, organizationId: org.id, status: "ACTIVE", isPublicBookable: true,
      timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00", minimumNights: 1,
    } });
    const reservation = await db.reservation.create({ data: {
      propertyId: property.id, guestName: "Synthetic", guestEmail: `${key}@example.invalid`, guestToken: key,
      source: "DIRECT_BOOKING", status: "ACTIVE", paymentState: "PAID", currency: "usd",
      adults: 2, children: 0, selectedAmenityIds: [], totalAmount: 150,
      amountCollected: 150, platformFeeAmount: 0, hostPayoutAmount: 150, stripeConnectedAccountId: "acct_synthetic",
      checkIn: new Date("2026-09-26T20:00:00Z"), checkOut: new Date("2026-09-27T15:00:00Z"),
      pricingBreakdown: {
        currency: "usd", nights: 1, nightlyRate: 100, nightlyRates: [{date: "2026-09-26", rate: 100}],
        nightlySubtotal: 100, cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0,
        totalAmount: 150, totalAmountCents: 15000, amenities: [], taxes: [],
      },
    } });
    type Dependencies = NonNullable<Parameters<typeof confirmGuestReservationModification>[1]>;
    const dependencies: Dependencies = {
      client: db, now: () => new Date(now),
      env: { PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true", PIN_AI_ACTION_CANARY_RESERVATION_IDS: reservation.id },
      checkAvailability: async () => ({available: true, conflict: null}),
      calculatePricing: async () => ({
        currency: "usd", nights: 1, nightlyRate: 100,
        nightlyRates: [{date: "2026-09-27", rate: 100, reason: "Synthetic", appliedRules: [], pricingBreakdown: []}],
        nightlySubtotal: 100, cleaningFee: 0, amenities: [], chargedAmenities: [], amenitiesTotal: 0,
        taxableSubtotal: 100, taxes: [], taxesTotal: 0, totalAmount: 100, totalAmountCents: 10000, auditEntries: [],
      }),
    };
    const input = {
      guestToken: key, operation: "EXTEND_CHECKOUT_ONLY" as const,
      checkIn: reservation.checkIn, checkOut: new Date("2026-09-28T15:00:00Z"),
      adults: 2, children: 0, selectedAmenityIds: [],
    };
    const preview = await getGuestReservationModificationPreview(input, dependencies);
    const confirmation = {
      ...input, clientRequestId: `${key}-request`, confirmationSource: "PIN_AI_GUEST_SERVICES" as const,
      expectedPreviewFingerprint: preview.previewFingerprint, actionProposalId: `${key}-proposal`,
      actionProposalFingerprint: "b".repeat(64), actionProposalConfirmedAt: new Date(now),
    };
    // Both requests must pass the early replay lookup before either enters its DB transaction.
    let arrivals = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>(resolve => { release = resolve; });
    dependencies.checkAvailability = async () => {
      if (!concurrent) return {available: true, conflict: null};
      arrivals++;
      if (arrivals === 2) release();
      await rendezvous;
      return {available: true, conflict: null};
    };
    return { reservation, dependencies, confirmation };
  }

  for (const sameRequestId of [true, false]) {
    await t.test(`concurrent confirmations same request ID=${sameRequestId}`, {timeout: 15000}, async () => {
      const f = await fixture();
      const results = await Promise.allSettled([
        confirmGuestReservationModification(f.confirmation, f.dependencies),
        confirmGuestReservationModification({...f.confirmation, clientRequestId: sameRequestId ? f.confirmation.clientRequestId : `${f.confirmation.clientRequestId}-other`}, f.dependencies),
      ]);
      const successes = results.filter(r => r.status === "fulfilled");
      assert.equal(successes.length, sameRequestId ? 2 : 1);
      if (sameRequestId) {
        const values = successes.map(r => r.value);
        assert.equal(values[0].modification.id, values[1].modification.id);
        assert.deepEqual(values.map(v => v.idempotentReplay).sort(), [false, true]);
      } else {
        const rejected = results.find(r => r.status === "rejected");
        assert.equal(rejected?.reason.code, "ACTIVE_RESERVATION_MODIFICATION_EXISTS");
      }
      const records = await db.reservationModification.findMany({where: {reservationId: f.reservation.id}});
      assert.equal(records.length, 1);
      assert.equal(records[0].status, "AWAITING_PAYMENT");
      assert.equal(Number(records[0].additionalChargeAmount), 100);
      assert.equal(records[0].stripeCheckoutSessionId, null);
      assert.equal(records[0].appliedAt, null);
      assert.deepEqual(await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}}), f.reservation);
      const replay = await confirmGuestReservationModification({...f.confirmation, clientRequestId: records[0].clientRequestId}, f.dependencies);
      assert.equal(replay.idempotentReplay, true);
    });
  }

  for (const scenario of ["apply-and-replay", "missing-payment", "blocked-dates", "changed-reservation"] as const) {
    await t.test(`real apply transaction: ${scenario}`, async () => {
      const f = await fixture(false);
      const confirmed = await confirmGuestReservationModification(f.confirmation, f.dependencies);
      const id = confirmed.modification.id;
      // Synthetic evidence only: no provider call, checkout creation or real payment.
      await db.reservationModification.update({where: {id}, data: {
        status: "APPLYING",
        ...(scenario === "missing-payment" ? {} : {
          stripeConnectedAccountId: "acct_synthetic", stripeCheckoutSessionId: `cs_synthetic_${id}`,
          stripePaymentIntentId: `pi_synthetic_${id}`, stripeChargeId: `ch_synthetic_${id}`,
          stripeApplicationFeeId: `fee_synthetic_${id}`, stripePaymentStatus: "paid",
        }),
      }});
      if (scenario === "blocked-dates") {
        await db.propertyBlockedDate.create({data: {
          propertyId: f.reservation.propertyId, startDate: f.reservation.checkOut,
          endDate: f.confirmation.checkOut,
        }});
      }
      if (scenario === "changed-reservation") {
        await db.reservation.update({where: {id: f.reservation.id}, data: {totalAmount: 151}});
      }
      const before = await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}});
      const reconciled: string[] = [];
      const dependencies = {client: db, now: () => new Date(now), reconcile: async (reservationId: string) => {reconciled.push(reservationId);} };
      if (scenario !== "apply-and-replay") {
        const expected = scenario === "missing-payment" ? "RESERVATION_MODIFICATION_PAYMENT_EVIDENCE_INCOMPLETE"
          : scenario === "blocked-dates" ? "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION_APPLY"
          : "RESERVATION_CHANGED_BEFORE_MODIFICATION_APPLY";
        await assert.rejects(applyGuestReservationModification({modificationId: id}, dependencies),
          (error: unknown) => (error as {code?: string}).code === expected);
        assert.deepEqual(await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}}), before);
        const failed = await db.reservationModification.findUniqueOrThrow({where: {id}});
        assert.equal(failed.status, "APPLYING");
        assert.equal(failed.appliedAt, null);
        assert.equal(failed.failureCode, expected);
        assert.deepEqual(reconciled, []);
      } else {
        await applyGuestReservationModification({modificationId: id}, dependencies);
        const applied = await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}});
        assert.equal(applied.checkIn.getTime(), before.checkIn.getTime());
        assert.equal(applied.checkOut.getTime(), f.confirmation.checkOut.getTime());
        assert.equal(Number(applied.totalAmount), 250);
        assert.equal(Number(applied.amountCollected), 250);
        assert.equal(Number(applied.platformFeeAmount) + Number(applied.hostPayoutAmount), 250);
        assert.equal((await db.reservationModification.findUniqueOrThrow({where: {id}})).status, "APPLIED");
        await applyGuestReservationModification({modificationId: id}, dependencies);
        assert.deepEqual(await db.reservation.findUniqueOrThrow({where: {id: f.reservation.id}}), applied);
        assert.ok(reconciled.every(value => value === f.reservation.id));
        assert.ok(reconciled.length > 0);
      }
    });
  }

});
