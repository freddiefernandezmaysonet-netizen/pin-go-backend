import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service.js";
import { validatePaidStayTimeCheckout, validatePaidStayTimeApply, validateFreeStayTimeApply } from "./stay-time-apply-validation.service.js";
import { syntheticStayTimePaymentEvidence } from "./stay-time-payment-evidence.fixture.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("paid stay-time preflight revalidates persisted consent and current operations without writes", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  t.after(() => db.$disconnect());
  for (const phase of ["CHECKOUT", "APPLY"] as const) for (const scenario of ["late", "early", "cleaning-revoked", "turnover-blocked", "price-changed", "amount-tampered",
    "fingerprint-tampered", "existing-session", "wrong-reservation", "expired", "setup-too-short"] as const) {
    await t.test(`${phase}: ${scenario}`, async () => {
      const early = scenario === "early" || scenario === "cleaning-revoked";
      const stagedAt = new Date(early ? "2026-10-01T12:00Z" : "2026-10-02T12:00Z");
      const org = await db.organization.create({ data: { name: "Synthetic paid preflight" } });
      const defaults = defaultStayTimeSettings();
      const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic paid preflight",
        timezone: "America/Puerto_Rico", checkInTime: early ? "15:00" : "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true,
        cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
        stayTimeSettings: { earlyCheckin: { ...defaults.earlyCheckin, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } },
          lateCheckout: { ...defaults.lateCheckout, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } } } } });
      const reservation = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
        guestToken: `synthetic-preflight-${property.id}`, checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
        status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
        currency: "usd", totalAmount: 150, amountCollected: 150, platformFeeAmount: 2.25, hostPayoutAmount: 147.75,
        stripeConnectedAccountId: "acct_synthetic_preflight",
        pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000,
          nightlySubtotal: 100, nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }],
          cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
      let staffId: string | undefined;
      let workId: string | undefined;
      try {
        if (early) {
          const prior = await db.reservation.create({ data: { propertyId: property.id, guestName: "Prior synthetic guest",
            checkIn: new Date("2026-09-29T19:00Z"), checkOut: new Date("2026-10-01T10:00Z") } });
          const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner" } });
          staffId = staff.id;
          await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY" } });
          const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: prior.id, propertyId: property.id,
            staffMemberId: staff.id, status: "CONFIRMED", token: `synthetic-preflight-${staff.id}` } });
          const work = await db.cleaningWork.create({ data: { reservationId: prior.id, propertyId: property.id, staffMemberId: staff.id,
            confirmationId: confirmation.id, scheduledStartAt: new Date("2026-10-01T10:30Z"), durationCommitmentMinutes: 30,
            startConfirmationGraceMinutes: 5, followupGraceMinutes: 5, timingConsentVersion: "v1",
            timingConsentAcceptedAt: new Date("2026-09-29T15:00Z"), startConfirmedAt: new Date("2026-10-01T10:30Z"),
            completionConfirmedAt: new Date("2026-10-01T11:00Z") } });
          workId = work.id;
        }
        const options = { now: stagedAt, platformFeePercent: "1.5" };
        const proposal = await createStayTimeProposal(db, { guestToken: reservation.guestToken!, language: "es",
          operation: early ? "EARLY_CHECKIN" : "LATE_CHECKOUT", requestedLocalTime: early ? "12:00" : "12:30" }, options);
        await confirmStayTimeProposal(db, { guestToken: reservation.guestToken!, proposalId: proposal.proposal.id,
          confirmationToken: proposal.confirmationToken }, options);
        const staged = await stageStayTimeModification(db, { guestToken: reservation.guestToken!, proposalId: proposal.proposal.id }, options);
        const id = staged.modification.id;
        if (phase === "APPLY") await db.reservationModification.update({ where: { id }, data: {
          status: "APPLYING", stripePaymentStatus: "paid", stripeConnectedAccountId: reservation.stripeConnectedAccountId,
          stripeCheckoutSessionId: "cs_synthetic_preflight", stripePaymentIntentId: "pi_synthetic_preflight",
          stripeChargeId: "ch_synthetic_preflight", stripeApplicationFeeId: "fee_synthetic_preflight",
        } });
        if (scenario === "cleaning-revoked") await db.cleaningWork.update({ where: { id: workId! }, data: { completionConfirmedAt: null } });
        if (scenario === "turnover-blocked") await db.propertyBlockedDate.create({ data: { propertyId: property.id,
          startDate: new Date("2026-10-03T19:59Z"), endDate: new Date("2026-10-04T15:00Z") } });
        if (scenario === "price-changed") await db.reservation.update({ where: { id: reservation.id }, data: { totalAmount: 151 } });
        if (scenario === "amount-tampered") await db.reservationModification.update({ where: { id }, data: { additionalChargeAmount: 999 } });
        if (scenario === "fingerprint-tampered") await db.reservationModification.update({ where: { id }, data: { requestFingerprint: "tampered" } });
        if (phase === "CHECKOUT" && scenario === "existing-session") await db.reservationModification.update({ where: { id }, data: { stripeCheckoutSessionId: "cs_test_existing" } });
        const now = new Date(stagedAt.getTime() + (scenario === "expired" ? 3_600_000 : scenario === "setup-too-short" ? 1_800_000 : 120_000));
        const before = await db.reservationModification.findUniqueOrThrow({ where: { id } });
        const beforeReservation = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        const validate = () => db.$transaction(async tx => {
          const m = await tx.reservationModification.findUniqueOrThrow({ where: { id } });
          const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
          const scopedReservation = scenario === "wrong-reservation" ? { ...r, id: "wrong" } : r;
          if (phase === "CHECKOUT") return validatePaidStayTimeCheckout(tx, m, scopedReservation, now);
          const evidence = syntheticStayTimePaymentEvidence(m, r, now);
          if (scenario === "existing-session") evidence.session.id = "cs_another_payment";
          // This internal validation must not open the canonical paid-apply gate.
          await assert.rejects(validateFreeStayTimeApply(tx, m, r, now),
            (error: unknown) => (error as { code?: string }).code === "STAY_TIME_PAYMENT_APPLY_NOT_READY");
          return validatePaidStayTimeApply(tx, m, scopedReservation, now, evidence);
        }, { isolationLevel: "RepeatableRead" });
        if (scenario === "early" || scenario === "late" || (phase === "APPLY" && scenario === "setup-too-short")) {
          const result = await validate();
          assert.equal(result.operation, early ? "EARLY_CHECKIN" : "LATE_CHECKOUT");
          assert.ok(now > proposal.proposal.expiresAt);
        } else await assert.rejects(validate);
        assert.deepEqual(await db.reservationModification.findUniqueOrThrow({ where: { id } }), before);
        assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), beforeReservation);
        assert.equal(await db.reservationModification.count({ where: { reservationId: reservation.id } }), 1);
      } finally {
        await db.reservationModification.deleteMany({ where: { reservationId: reservation.id } });
        await db.pinAIActionProposal.deleteMany({ where: { reservationId: reservation.id } });
        await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
        await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
        await db.reservation.deleteMany({ where: { propertyId: property.id } });
        await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
        if (staffId) await db.staffMember.delete({ where: { id: staffId } });
        await db.property.delete({ where: { id: property.id } });
        await db.organization.delete({ where: { id: org.id } });
      }
    });
  }
});
