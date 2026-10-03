import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings";
import { createStayTimeDepartureCleaningFixture } from "./stay-time-departure-cleaning.fixture";
import { prepareStayTimeGuestAction, confirmAndExecuteStayTimeGuestAction, type StayTimeGuestActionDependencies } from "./stay-time-guest-action.service";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("internal bridge rejects injected identity/payment fields and invalid server clocks before database work", async () => {
  const db = {} as PrismaClient;
  const clock = { now: () => new Date("2026-10-02T12:00Z"), platformFeePercent: "1.5" };
  const prepare = { guestToken: "synthetic-guest-token", operation: "LATE_CHECKOUT" as const, requestedLocalTime: "12:30", language: "es" as const };
  const confirm = { guestToken: prepare.guestToken, proposalId: "synthetic-proposal", confirmationToken: "synthetic-secret" };
  for (const injected of [{ organizationId: "other-tenant" }, { amountMinor: 1 }, { checkoutUrl: "https://untrusted.invalid" }]) {
    await assert.rejects(prepareStayTimeGuestAction(db, { ...prepare, ...injected }, clock), /INVALID_STAY_TIME_REQUEST/);
    await assert.rejects(confirmAndExecuteStayTimeGuestAction({ ...confirm, ...injected }, { client: db, ...clock, reconcile: async () => undefined }), /INVALID_STAY_TIME_REQUEST/);
  }
  await assert.rejects(prepareStayTimeGuestAction(db, prepare, { ...clock, now: () => new Date(NaN) }), /INVALID_STAY_TIME/);
});
test("internal guest stay-time bridge preserves consent, idempotency and payment separation", { skip: !url }, async t => {
  const parsed = new URL(url!); assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } }); t.after(() => db.$disconnect());
  for (const scenario of ["late", "early", "cleaning-cutoff", "wrong-guest", "wrong-secret", "expired", "blocked", "paid", "provider-retry", "missing-provider", "reconcile-retry", "unsafe-checkout"] as const) {
    await t.test(scenario, async () => {
      const early = scenario === "early", paid = ["paid", "provider-retry", "missing-provider", "unsafe-checkout"].includes(scenario);
      let clock = new Date(early ? "2026-10-01T12:00Z" : "2026-10-02T12:00Z");
      const org = await db.organization.create({ data: { name: "Synthetic guest stay-time bridge" } });
      const defaults = defaultStayTimeSettings();
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic bridge property", timezone: "America/Puerto_Rico",
        checkInTime: early || scenario === "cleaning-cutoff" ? "15:00" : "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true, cleaningStartOffsetMinutes: 30,
        stayTimeSettings: { earlyCheckin: { ...defaults.earlyCheckin, enabled: true }, lateCheckout: { ...defaults.lateCheckout,
          enabled: true, fee: { mode: paid ? "PER_HOUR" : "FREE", amountMinor: 0, currency: "USD" } } } } });
      const stay = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic bridge guest",
        guestToken: `synthetic-bridge-${property.id}`, checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
        paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", currency: "usd", totalAmount: 150,
        amountCollected: 150, platformFeeAmount: 2.25, hostPayoutAmount: 147.75,
        pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000, nightlySubtotal: 100,
          nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }], cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
      let staffId: string | null = null;
      try {
        if (!early) staffId = (await createStayTimeDepartureCleaningFixture(db, stay, clock)).staffId;
        else {
          const prior = await db.reservation.create({ data: { propertyId: property.id, guestName: "Prior synthetic stay", checkIn: new Date("2026-09-29T19:00Z"), checkOut: new Date("2026-10-01T10:00Z") } });
          const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner" } }); staffId = staff.id;
          await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY" } });
          const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: prior.id, propertyId: property.id, staffMemberId: staff.id,
            status: "CONFIRMED", token: `synthetic-bridge-cleaner-${staff.id}` } });
          await db.cleaningWork.create({ data: { reservationId: prior.id, propertyId: property.id, staffMemberId: staff.id, confirmationId: confirmation.id,
            scheduledStartAt: new Date("2026-10-01T10:30Z"), durationCommitmentMinutes: 30, startConfirmationGraceMinutes: 5,
            followupGraceMinutes: 5, timingConsentVersion: "v1", timingConsentAcceptedAt: new Date("2026-09-29T15:00Z"),
            startConfirmedAt: new Date("2026-10-01T10:30Z"), completionConfirmedAt: new Date("2026-10-01T11:00Z") } });
        }
        let checkoutCalls = 0, reconcileCalls = 0;
        const deps: StayTimeGuestActionDependencies = { client: db, now: () => clock, platformFeePercent: "1.5", reconcile: async () => {
          reconcileCalls++; if (scenario === "reconcile-retry" && reconcileCalls === 1) throw new Error("SYNTHETIC_RECONCILE_OUTAGE");
        }, ...(scenario === "missing-provider" ? {} : { createCheckout: async (input: { guestToken: string; modificationId: string }) => {
          checkoutCalls++; assert.equal(input.guestToken, stay.guestToken);
          const m = await db.reservationModification.findUniqueOrThrow({ where: { id: input.modificationId } });
          assert.equal(m.reservationId, stay.id); assert.equal(m.status, "AWAITING_PAYMENT");
          if (scenario === "provider-retry" && checkoutCalls === 1) throw new Error("SYNTHETIC_CHECKOUT_OUTAGE");
          return { outcome: "CHECKOUT_READY" as const, actionExecuted: false as const,
            checkoutUrl: scenario === "unsafe-checkout" ? "https://untrusted.invalid/pay" : "https://checkout.stripe.com/c/pay/synthetic",
            checkoutSessionId: "cs_synthetic", checkoutExpiresAt: m.checkoutExpiresAt!, idempotentReplay: checkoutCalls > 1 };
        } }) };
        if (scenario === "cleaning-cutoff") {
          await assert.rejects(prepareStayTimeGuestAction(db, { guestToken: stay.guestToken!, operation: "LATE_CHECKOUT", requestedLocalTime: "12:30", language: "es" }, deps), /CLEANING_CHECKIN_LIMIT_EXCEEDED/);
          assert.equal(await db.pinAIActionProposal.count({ where: { reservationId: stay.id } }), 0);
          assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
          assert.equal(checkoutCalls, 0); assert.equal(reconcileCalls, 0); return;
        }
        const prepared = await prepareStayTimeGuestAction(db, { guestToken: stay.guestToken!, operation: early ? "EARLY_CHECKIN" : "LATE_CHECKOUT",
          requestedLocalTime: early ? "12:00" : "12:30", language: "es" }, deps);
        assert.equal(prepared.publicResult.actionExecuted, false); assert.equal(prepared.publicResult.availabilityHeld, false);
        assert.match(prepared.publicResult.quote.consentText, /impuestos incluidos/);
        assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
        const publicText = JSON.stringify(prepared.publicResult);
        for (const secret of [prepared.privateConfirmation.confirmationToken, "arrivalReadinessEvidenceId", "departureCleaning", "basePricingSnapshot", "organizationId"]) assert.ok(!publicText.includes(secret));
        const input = { guestToken: stay.guestToken!, proposalId: prepared.privateConfirmation.proposalId, confirmationToken: prepared.privateConfirmation.confirmationToken };
        clock = new Date(clock.getTime() + (scenario === "expired" ? 60_000 : 5_000));
        if (scenario === "wrong-guest") input.guestToken = "synthetic-unrelated-guest-token";
        if (scenario === "wrong-secret") input.confirmationToken = "synthetic-invalid-confirmation-token";
        if (scenario === "blocked") await db.propertyBlockedDate.create({ data: { propertyId: property.id,
          startDate: stay.checkOut, endDate: new Date("2026-10-03T21:00Z") } });
        if (["wrong-guest", "wrong-secret", "expired", "blocked"].includes(scenario)) {
          await assert.rejects(confirmAndExecuteStayTimeGuestAction(input, deps));
          assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
          assert.equal(checkoutCalls, 0); assert.equal(reconcileCalls, 0);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), stay);
          return;
        }
        if (["provider-retry", "reconcile-retry", "missing-provider", "unsafe-checkout"].includes(scenario)) {
          await assert.rejects(confirmAndExecuteStayTimeGuestAction(input, deps));
          assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 1);
          if (["missing-provider", "unsafe-checkout"].includes(scenario)) {
            assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), stay); return;
          }
        }
        const result = await confirmAndExecuteStayTimeGuestAction(input, deps);
        if (paid) {
          assert.equal(result.outcome, "CHECKOUT_READY"); assert.equal(result.actionExecuted, false);
          assert.equal(result.reservationChanged, false); assert.equal(reconcileCalls, 0);
          assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), stay);
          assert.equal(prepared.publicResult.quote.additionalChargeMinor, 500);
        } else {
          assert.equal(result.outcome, "APPLIED"); assert.equal(result.actionExecuted, true); assert.equal(checkoutCalls, 0);
          const changed = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
          assert.equal((early ? changed.checkIn : changed.checkOut).toISOString(), early ? "2026-10-01T16:00:00.000Z" : "2026-10-03T16:30:00.000Z");
          assert.equal(changed.amountCollected.toString(), "150");
        }
        const replay = await confirmAndExecuteStayTimeGuestAction(input, deps);
        assert.equal(replay.modificationId, result.modificationId); assert.equal(replay.idempotentReplay, true);
        assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 1);
      } finally {
        await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
        await db.pinAIActionProposal.deleteMany({ where: { propertyId: property.id } });
        await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
        await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
        await db.reservation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
        await db.property.delete({ where: { id: property.id } });
        if (staffId) await db.staffMember.delete({ where: { id: staffId } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
