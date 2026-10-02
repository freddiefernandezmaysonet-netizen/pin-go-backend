import assert from "node:assert/strict";
import test from "node:test";
import { createStayTimeDepartureCleaningFixture } from "./stay-time-departure-cleaning.fixture.js";
import { Prisma, PrismaClient } from "@prisma/client";
import { estimateStayTimeAdjustment, resolveStayTimeClock } from "./stay-time-estimate.service.js";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";
import { prepareStayTimeQuote } from "./stay-time-quote.service.js";
import { createStayTimeProposal, confirmStayTimeProposal, stageStayTimeModification } from "./stay-time-proposal.service.js";
import { isConfirmedInStayExtension } from "../pin-ai/actions/in-stay-extension-confirmation.js";
import { createPinAIActionProposal, confirmPinAIActionProposal } from "../pin-ai/actions/action-proposal.service.js";

test("property-local clock resolution rejects DST gaps and folds", () => {
  assert.equal(resolveStayTimeClock(new Date("2026-10-01T19:00Z"), "12:30", "America/Puerto_Rico").toISOString(), "2026-10-01T16:30:00.000Z");
  assert.throws(() => resolveStayTimeClock(new Date("2026-03-08T19:00Z"), "02:30", "America/New_York"), /NONEXISTENT_LOCAL_TIME/);
  assert.throws(() => resolveStayTimeClock(new Date("2026-11-01T19:00Z"), "01:30", "America/New_York"), /AMBIGUOUS_LOCAL_TIME/);
  assert.throws(() => resolveStayTimeClock(new Date("2026-04-05T06:00Z"), "01:45", "Australia/Lord_Howe"), /AMBIGUOUS_LOCAL_TIME/);
  assert.equal(resolveStayTimeClock(new Date("2026-11-01T19:00Z"), "03:30", "America/New_York").toISOString(), "2026-11-01T08:30:00.000Z");
  assert.throws(() => resolveStayTimeClock(new Date(), "24:00", "America/Puerto_Rico"), /INVALID_LOCAL_TIME/);
  assert.throws(() => resolveStayTimeClock(new Date(), "12:00", ""), /INVALID_TIMEZONE/);
});

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("stay-time estimates use real scoped PostgreSQL evidence without writes", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const org = await db.organization.create({ data: { name: "Synthetic estimate tests" } });
  const settings = defaultStayTimeSettings();
  const enabled = { earlyCheckin: { ...settings.earlyCheckin, enabled: true },
    lateCheckout: { ...settings.lateCheckout, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 0, currency: "USD" } } };
  const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic estimate property",
    timezone: "America/Puerto_Rico", checkInTime: "16:00", checkOutTime: "11:00", cleaningNfcEnabled: true,
    cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180, stayTimeSettings: enabled } });
  t.after(async () => {
    try {
      await db.pinAIActionProposal.deleteMany({ where: { propertyId: property.id } });
      await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
      await db.cleaningWork.deleteMany({ where: { propertyId: property.id } });
      await db.cleaningConfirmation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyStaff.deleteMany({ where: { propertyId: property.id } });
      await db.staffMember.deleteMany({ where: { organizationId: org.id } });
      await db.reservation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
      await db.property.delete({ where: { id: property.id } });
      await db.organization.delete({ where: { id: org.id } });
    } finally { await db.$disconnect(); }
  });
  const now = new Date("2026-10-01T12:00:00Z");
  const stay = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
    checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
    status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", currency: "usd",
    guestToken: `synthetic-quote-${property.id}`, totalAmount: 150,
    pricingBreakdown: { currency: "usd", totalAmount: 150, totalAmountCents: 15000,
      nightlySubtotal: 100, nightlyRates: [{ date: "2026-10-01", rate: 40 }, { date: "2026-10-02", rate: 60 }], cleaningFee: 50, amenitiesTotal: 0, taxesTotal: 0 } } });
  const departure = await createStayTimeDepartureCleaningFixture(db, stay, now);
  const input = { organizationId: org.id, propertyId: property.id, reservationId: stay.id,
    operation: "LATE_CHECKOUT" as const, requestedLocalTime: "12:30" };
  const estimate = () => estimateStayTimeAdjustment(db, input, now);
  const conflictStay = async (checkIn: string, checkOut: string) => db.reservation.create({ data: {
    propertyId: property.id, guestName: "Synthetic conflict", checkIn: new Date(checkIn), checkOut: new Date(checkOut),
  } });
  await t.test("financial quote authenticates guest, binds taxes/state and never writes a proposal", async () => {
    const tax = await db.propertyTax.create({ data: { propertyId: property.id, name: "Synthetic configured tax", percentage: 9 } });
    const quoteInput = { guestToken: stay.guestToken!, operation: "LATE_CHECKOUT" as const, requestedLocalTime: "12:30" };
    const options = { now, platformFeePercent: "1.5" };
    try {
      const before = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
      const quote = await prepareStayTimeQuote(db, quoteInput, options);
      assert.equal(quote.terms.pricing.additionalChargeMinor, 545);
      assert.equal(quote.terms.pricing.proposedTotalMinor, 15545);
      assert.equal(quote.confirmationAvailable, false);
      assert.equal(quote.paymentReady, false);
      assert.equal(quote.terms.expiresAt, "2026-10-01T12:01:00.000Z");
      assert.equal((await prepareStayTimeQuote(db, quoteInput, options)).fingerprint, quote.fingerprint);
      assert.notEqual((await prepareStayTimeQuote(db, quoteInput, { ...options, platformFeePercent: "2" })).fingerprint, quote.fingerprint);
      await db.propertyTax.update({ where: { id: tax.id }, data: { percentage: 10 } });
      assert.notEqual((await prepareStayTimeQuote(db, quoteInput, options)).fingerprint, quote.fingerprint);
      await assert.rejects(prepareStayTimeQuote(db, { ...quoteInput, guestToken: "unknown-guest-token-12345" }, options), /NOT_FOUND/);
      assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), before);
      assert.equal(await db.pinAIActionProposal.count({ where: { reservationId: stay.id } }), 0);
      await db.reservation.update({ where: { id: stay.id }, data: { guestTokenExpiresAt: now } });
      await assert.rejects(prepareStayTimeQuote(db, quoteInput, options), /NOT_FOUND/);
      await db.reservation.update({ where: { id: stay.id }, data: { guestTokenExpiresAt: null } });
    } finally { await db.propertyTax.delete({ where: { id: tax.id } }); }
  });
  const proposalInput = { guestToken: stay.guestToken!, operation: "LATE_CHECKOUT" as const,
    requestedLocalTime: "12:30", language: "es" as const };
  const proposalOptions = { now, platformFeePercent: "1.5" };
  await t.test("assigned cleaner duration sets each cutoff and invalidates earlier consent", async () => {
    const created = await createStayTimeProposal(db, proposalInput, proposalOptions);
    const duration = async (minutes: number) => {
      await db.propertyStaff.update({ where: { id: departure.assignmentId }, data: { cleaningDurationCommitmentMinutes: minutes } });
      await db.cleaningWork.update({ where: { id: departure.workId }, data: { durationCommitmentMinutes: minutes } });
    };
    try {
      await duration(120);
      await estimateStayTimeAdjustment(db, { ...input, requestedLocalTime: "13:30" }, now);
      await assert.rejects(estimateStayTimeAdjustment(db, { ...input, requestedLocalTime: "13:31" }, now), /CLEANING_CHECKIN_LIMIT_EXCEEDED/);
      await assert.rejects(confirmStayTimeProposal(db, { guestToken: stay.guestToken!, proposalId: created.proposal.id,
        confirmationToken: created.confirmationToken }, proposalOptions), /QUOTE_CHANGED/);
      await duration(240);
      await estimateStayTimeAdjustment(db, { ...input, requestedLocalTime: "11:30" }, now);
      await assert.rejects(estimate(), /CLEANING_CHECKIN_LIMIT_EXCEEDED/);
      await duration(180);
      await db.propertyStaff.update({ where: { id: departure.assignmentId }, data: { cleaningDurationCommitmentMinutes: 120 } });
      await assert.rejects(estimate(), /DEPARTURE_CLEANING_COMMITMENT_REQUIRED/);
    } finally {
      await duration(180);
      await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } });
    }
  });
  const confirmInput = (created: Awaited<ReturnType<typeof createStayTimeProposal>>) => ({
    guestToken: stay.guestToken!, proposalId: created.proposal.id, confirmationToken: created.confirmationToken,
  });
  await t.test("missing, inactive and replaced departure commitments cannot reuse a quote", async () => {
    const created = await createStayTimeProposal(db, proposalInput, proposalOptions);
    let replacementId: string | null = null;
    try {
      await db.cleaningWork.update({ where: { id: departure.workId }, data: { supersededAt: now } });
      await assert.rejects(estimate(), /DEPARTURE_CLEANING_COMMITMENT_REQUIRED/);
      await db.cleaningWork.update({ where: { id: departure.workId }, data: { supersededAt: null } });
      await db.staffMember.update({ where: { id: departure.staffId }, data: { isActive: false } });
      await assert.rejects(estimate(), /DEPARTURE_CLEANING_COMMITMENT_REQUIRED/);
      await db.staffMember.update({ where: { id: departure.staffId }, data: { isActive: true } });
      await db.cleaningConfirmation.update({ where: { id: departure.confirmationId }, data: { status: "EXPIRED" } });
      const replacement = await db.cleaningConfirmation.create({ data: { reservationId: stay.id, propertyId: property.id,
        staffMemberId: departure.staffId, status: "CONFIRMED", token: `replacement-${departure.confirmationId}` } });
      replacementId = replacement.id;
      await db.cleaningWork.update({ where: { id: departure.workId }, data: { confirmationId: replacement.id } });
      await estimate();
      await assert.rejects(confirmStayTimeProposal(db, confirmInput(created), proposalOptions), /QUOTE_CHANGED/);
    } finally {
      await db.staffMember.update({ where: { id: departure.staffId }, data: { isActive: true } });
      await db.cleaningWork.update({ where: { id: departure.workId }, data: { supersededAt: null, confirmationId: departure.confirmationId } });
      if (replacementId) await db.cleaningConfirmation.delete({ where: { id: replacementId } });
      await db.cleaningConfirmation.update({ where: { id: departure.confirmationId }, data: { status: "CONFIRMED" } });
      await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } });
    }
  });
  await t.test("explicit consent is revalidated, token-protected and idempotent without applying or charging", async () => {
    const before = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
    const created = await createStayTimeProposal(db, proposalInput, proposalOptions);
    try {
      assert.equal(created.proposal.status, "PENDING_CONFIRMATION");
      assert.match(created.proposal.consentText, /USD 5.00/);
      assert.match(created.proposal.consentText, /no cambia la reserva/);
      const stored = await db.pinAIActionProposal.findUniqueOrThrow({ where: { id: created.proposal.id } });
      assert.notEqual(stored.confirmationTokenHash, created.confirmationToken);
      await assert.rejects(confirmStayTimeProposal(db, { ...confirmInput(created), confirmationToken: "x".repeat(43) }, proposalOptions), /TOKEN_MISMATCH/);
      await assert.rejects(confirmStayTimeProposal(db, { ...confirmInput(created), guestToken: "another-guest-token-12345" }, proposalOptions), /RESERVATION_NOT_FOUND/);
      await assert.rejects(confirmPinAIActionProposal({ prisma: db, ...confirmInput(created), now }), /PROPOSAL_NOT_CONFIRMABLE/);
      const results = await Promise.all([1, 2].map(() => confirmStayTimeProposal(db, confirmInput(created), {
        ...proposalOptions, now: new Date(now.getTime() + 10_000),
      })));
      assert.deepEqual(results.map(r => r.idempotentReplay).sort(), [false, true]);
      for (const result of results) {
        assert.equal(result.proposal.status, "CONFIRMED");
        assert.equal(result.actionExecuted, false);
        assert.equal(result.paymentReady, false);
        assert.equal(result.availabilityHeld, false);
      }
      assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), before);
      assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
    } finally { await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } }); }
  });
  await t.test("stale price, settings and occupancy cannot record stay-time consent", async () => {
    const created = await createStayTimeProposal(db, proposalInput, proposalOptions);
    const confirm = () => confirmStayTimeProposal(db, confirmInput(created), proposalOptions);
    try {
      await assert.rejects(confirmStayTimeProposal(db, confirmInput(created), { ...proposalOptions, platformFeePercent: "2" }), /QUOTE_CHANGED/);
      const tax = await db.propertyTax.create({ data: { propertyId: property.id, name: "New tax", percentage: 9 } });
      try { await assert.rejects(confirm(), /QUOTE_CHANGED/); }
      finally { await db.propertyTax.delete({ where: { id: tax.id } }); }
      await db.property.update({ where: { id: property.id }, data: { stayTimeSettingsRevision: 1 } });
      try { await assert.rejects(confirm(), /QUOTE_CHANGED/); }
      finally { await db.property.update({ where: { id: property.id }, data: { stayTimeSettingsRevision: 0 } }); }
      const conflict = await conflictStay("2026-10-03T16:00Z", "2026-10-04T15:00Z");
      try { await assert.rejects(confirm(), /CONFLICT|UNAVAILABLE/); }
      finally { await db.reservation.delete({ where: { id: conflict.id } }); }
      assert.equal((await db.pinAIActionProposal.findUniqueOrThrow({ where: { id: created.proposal.id } })).status, "PENDING_CONFIRMATION");
    } finally { await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } }); }
  });
  await t.test("expired consent and generic creation without stay-time validation fail closed", async () => {
    const quote = await prepareStayTimeQuote(db, proposalInput, proposalOptions);
    await assert.rejects(createPinAIActionProposal({ prisma: db, guestToken: stay.guestToken!,
      actionType: "RESERVATION_MODIFICATION", language: "en", consentText: "Confirm", termsSnapshot: quote.terms,
      expiresAt: new Date(quote.terms.expiresAt), now }), /INVALID_TERMS/);
    const created = await createStayTimeProposal(db, { ...proposalInput, language: "en" }, proposalOptions);
    try {
      assert.match(created.proposal.consentText, /late checkout/);
      await assert.rejects(confirmStayTimeProposal(db, confirmInput(created), {
        ...proposalOptions, now: new Date(now.getTime() + 60_000),
      }), /PROPOSAL_EXPIRED/);
      assert.equal((await db.pinAIActionProposal.findUniqueOrThrow({ where: { id: created.proposal.id } })).status, "EXPIRED");
    } finally { await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } }); }
  });
  await t.test("confirmed paid stay-time handoff persists one canonical modification without charging or changing dates", async () => {
    const before = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
    const created = await createStayTimeProposal(db, proposalInput, proposalOptions);
    const stageInput = { guestToken: stay.guestToken!, proposalId: created.proposal.id };
    try {
      await assert.rejects(stageStayTimeModification(db, stageInput, proposalOptions), /CONFIRMED_PROPOSAL_REQUIRED/);
      await confirmStayTimeProposal(db, confirmInput(created), proposalOptions);
      await assert.rejects(stageStayTimeModification(db, stageInput, { ...proposalOptions, platformFeePercent: "2" }), /QUOTE_CHANGED/);
      await assert.rejects(stageStayTimeModification(db, { ...stageInput, guestToken: "wrong-guest-token-12345" }, proposalOptions), /RESERVATION_NOT_FOUND/);
      const results = await Promise.all([1, 2].map(() => stageStayTimeModification(db, stageInput, proposalOptions)));
      assert.deepEqual(results.map(r => r.idempotentReplay).sort(), [false, true]);
      assert.equal(results[0]!.modification.id, results[1]!.modification.id);
      const m = results[0]!.modification;
      assert.equal(m.status, "AWAITING_PAYMENT");
      assert.equal(m.financialAction, "ADDITIONAL_PAYMENT_REQUIRED");
      assert.equal(m.additionalChargeAmount.toString(), "5");
      assert.equal(m.additionalPlatformFeeAmount.toString(), "0.08");
      assert.equal(m.additionalHostPayoutAmount.toString(), "4.92");
      assert.equal(m.proposedTotalAmount.toString(), "155");
      assert.deepEqual(m.currentPricing, before.pricingBreakdown);
      const pricing = m.proposedPricing as Record<string, unknown>;
      assert.equal(pricing.totalAmount, 155);
      assert.equal(pricing.cleaningFee, 50);
      assert.deepEqual(pricing.nightlyRates, (before.pricingBreakdown as Record<string, unknown>).nightlyRates);
      assert.equal(m.checkoutExpiresAt?.toISOString(), "2026-10-01T13:00:00.000Z");
      assert.equal(m.stripeCheckoutSessionId, null);
      assert.equal(m.stripePaymentIntentId, null);
      assert.equal(results[0]!.paymentReady, false);
      assert.equal(results[0]!.actionExecuted, false);
      assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 1);
      assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), before);
      await assert.rejects(estimate(), /RESERVATION_CHANGE_IN_PROGRESS/);
      // Current generic checkout/apply's operation gate must reject until integration is complete.
      assert.throws(() => isConfirmedInStayExtension({ modification: m, reservation: before, now }), /EXTENSION_CONFIRMED_PROPOSAL_REQUIRED/);
      const replay = await stageStayTimeModification(db, stageInput, { ...proposalOptions, now: new Date(now.getTime() + 90_000) });
      assert.equal(replay.modification.id, m.id);
      assert.equal(replay.idempotentReplay, true);
    } finally {
      await db.reservationModification.deleteMany({ where: { reservationId: stay.id } });
      await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } });
    }
  });
  await t.test("expired consent, altered stored terms and insufficient payment time never create a modification", async () => {
    const created = await createStayTimeProposal(db, proposalInput, proposalOptions);
    try {
      await confirmStayTimeProposal(db, confirmInput(created), proposalOptions);
      const stageInput = { guestToken: stay.guestToken!, proposalId: created.proposal.id };
      await assert.rejects(stageStayTimeModification(db, stageInput, { ...proposalOptions,
        now: new Date(now.getTime() + 60_000) }), /QUOTE_EXPIRED/);
      await db.pinAIActionProposal.update({ where: { id: created.proposal.id }, data: { consentText: "Changed consent" } });
      await assert.rejects(stageStayTimeModification(db, stageInput, proposalOptions), /FINGERPRINT_MISMATCH/);
      assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
    } finally { await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } }); }
    const shortWindow = { ...proposalOptions, now: new Date(stay.checkOut.getTime() - 30 * 60_000) };
    const tooLate = await createStayTimeProposal(db, proposalInput, shortWindow);
    try {
      await confirmStayTimeProposal(db, confirmInput(tooLate), shortWindow);
      await assert.rejects(stageStayTimeModification(db, { guestToken: stay.guestToken!, proposalId: tooLate.proposal.id }, shortWindow), /PAYMENT_WINDOW_TOO_SHORT/);
      assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
    } finally { await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } }); }
  });
  await t.test("empty calendar does not allow cleaning past normal check-in or create a payable proposal", async () => {
    await estimate(); // 12:30 + 30 minutes + 180 minutes = 16:00 exactly.
    const tooLate = { guestToken: stay.guestToken!, operation: "LATE_CHECKOUT" as const, requestedLocalTime: "12:31" };
    await assert.rejects(estimateStayTimeAdjustment(db, { ...input, requestedLocalTime: "12:31" }, now), /CLEANING_CHECKIN_LIMIT_EXCEEDED/);
    await assert.rejects(createStayTimeProposal(db, { ...tooLate, language: "es" }, proposalOptions), /CLEANING_CHECKIN_LIMIT_EXCEEDED/);
    assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
    assert.equal(await db.propertyBlockedDate.count({ where: { propertyId: property.id } }), 0);
  });
  await t.test("exact minute fee, offset plus cleaning window, estimate only, no mutation", async () => {
    const before = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
    const result = await estimate();
    assert.equal(result.feeSubtotalMinor, 500);
    assert.equal(result.additionalMinutes, 90);
    assert.equal(result.requiredFreeUntil, "2026-10-03T20:00:00.000Z");
    assert.equal(result.checkIn, stay.checkIn.toISOString());
    assert.equal(result.checkOut, "2026-10-03T16:30:00.000Z");
    assert.equal(result.decision, "ESTIMATE_ONLY");
    for (const key of ["authorizationGranted", "actionExecuted", "executionAvailable", "availabilityHeld", "taxesIncluded", "paymentReady"] as const) assert.equal(result[key], false);
    assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: stay.id } }), before);
    assert.equal(await db.reservationModification.count({ where: { reservationId: stay.id } }), 0);
  });
  await t.test("tenant/property isolation, unpaid and OTA rejection", async () => {
    await assert.rejects(estimateStayTimeAdjustment(db, { ...input, organizationId: "other" }, now), /NOT_FOUND/);
    await assert.rejects(estimateStayTimeAdjustment(db, { ...input, propertyId: "other" }, now), /NOT_FOUND/);
    await db.reservation.update({ where: { id: stay.id }, data: { paymentState: "NONE" } });
    await assert.rejects(estimate(), /INELIGIBLE_RESERVATION/);
    await db.reservation.update({ where: { id: stay.id }, data: { paymentState: "PAID", externalProvider: "AIRBNB" } });
    await assert.rejects(estimate(), /DIRECT_BOOKING_REQUIRED/);
    await db.reservation.update({ where: { id: stay.id }, data: { externalProvider: "PIN_GO_DIRECT" } });
  });
  await t.test("early arrival never treats absent readiness as approval", async () => {
    await assert.rejects(estimateStayTimeAdjustment(db, { ...input, operation: "EARLY_CHECKIN", requestedLocalTime: "12:00" }, now), /ARRIVAL_READINESS_REQUIRED/);
  });
  await t.test("early arrival consumes the prior turnover completion without a second host approval", async () => {
    const prior = await conflictStay("2026-09-29T19:00Z", "2026-10-01T10:00Z");
    const staff = await db.staffMember.create({ data: { organizationId: org.id, fullName: "Synthetic cleaner" } });
    const assignment = await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id, role: "PRIMARY" } });
    const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: prior.id, propertyId: property.id,
      staffMemberId: staff.id, status: "CONFIRMED", token: `synthetic-${staff.id}` } });
    const completed = new Date("2026-10-01T11:00Z");
    const work = await db.cleaningWork.create({ data: { reservationId: prior.id, propertyId: property.id,
      staffMemberId: staff.id, confirmationId: confirmation.id, scheduledStartAt: new Date("2026-10-01T10:30Z"),
      durationCommitmentMinutes: 30, startConfirmationGraceMinutes: 5, followupGraceMinutes: 5,
      timingConsentVersion: "v1", timingConsentAcceptedAt: new Date("2026-09-29T15:00Z"),
      startConfirmedAt: new Date("2026-10-01T10:30Z"), completionConfirmedAt: completed } });
    const early = () => estimateStayTimeAdjustment(db, { ...input, operation: "EARLY_CHECKIN", requestedLocalTime: "12:00" }, now);
    try {
      const result = await early();
      assert.equal(result.decision, "ESTIMATE_ONLY");
      assert.equal(result.checkIn, "2026-10-01T16:00:00.000Z");
      assert.equal(result.checkOut, stay.checkOut.toISOString());
      assert.equal(result.authorizationGranted, false);
      const earlyProposal = await createStayTimeProposal(db, { ...proposalInput,
        operation: "EARLY_CHECKIN", requestedLocalTime: "12:00" }, proposalOptions);
      try {
        assert.match(earlyProposal.proposal.consentText, /USD 0.00/);
        await db.cleaningWork.update({ where: { id: work.id }, data: { completionConfirmedAt: null } });
        await assert.rejects(confirmStayTimeProposal(db, confirmInput(earlyProposal), proposalOptions), /ARRIVAL_READINESS_REQUIRED/);
        await db.cleaningWork.update({ where: { id: work.id }, data: { completionConfirmedAt: completed } });
        const consent = await confirmStayTimeProposal(db, confirmInput(earlyProposal), proposalOptions);
        assert.equal(consent.proposal.status, "CONFIRMED");
        assert.equal(consent.actionExecuted, false);
        const staged = await stageStayTimeModification(db, { guestToken: stay.guestToken!, proposalId: earlyProposal.proposal.id }, proposalOptions);
        assert.equal(staged.modification.status, "APPLYING");
        assert.equal(staged.modification.financialAction, "NO_PAYMENT_REQUIRED");
        assert.equal(staged.modification.additionalChargeAmount.toString(), "0");
        assert.equal(staged.modification.checkoutExpiresAt, null);
        assert.equal(staged.modification.proposedCheckIn.toISOString(), "2026-10-01T16:00:00.000Z");
        assert.equal(staged.modification.proposedCheckOut.toISOString(), stay.checkOut.toISOString());
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: stay.id } })).checkIn.toISOString(), stay.checkIn.toISOString());
      } finally {
        await db.reservationModification.deleteMany({ where: { reservationId: stay.id } });
        await db.pinAIActionProposal.deleteMany({ where: { reservationId: stay.id } });
      }
      for (const patch of [
        { completionConfirmedAt: null }, { cancelledAt: completed }, { supersededAt: completed },
        { completionConfirmedAt: new Date("2026-10-01T12:01Z") },
        { startConfirmedAt: new Date("2026-10-01T09:59Z") },
        { scheduledStartAt: new Date("2026-10-01T11:00Z") }, { timingConsentVersion: null },
        { confirmationId: "unrelated-confirmation" },
      ]) {
        await db.cleaningWork.update({ where: { id: work.id }, data: patch });
        await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/);
        await db.cleaningWork.update({ where: { id: work.id }, data: {
          completionConfirmedAt: completed, cancelledAt: null, supersededAt: null,
          startConfirmedAt: work.startConfirmedAt, scheduledStartAt: work.scheduledStartAt,
          timingConsentVersion: "v1", confirmationId: confirmation.id,
        } });
      }
      await db.propertyStaff.update({ where: { id: assignment.id }, data: { isActive: false } });
      await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/);
      await db.propertyStaff.update({ where: { id: assignment.id }, data: { isActive: true } });
      // An intervening stay has no completed turnover of its own.
      const intervening = await conflictStay("2026-10-01T11:00Z", "2026-10-01T11:30Z");
      try { await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/); }
      finally { await db.reservation.delete({ where: { id: intervening.id } }); }
      const block = await db.propertyBlockedDate.create({ data: { propertyId: property.id,
        startDate: new Date("2026-10-01T11:30Z"), endDate: new Date("2026-10-01T11:45Z") } });
      try { await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/); }
      finally { await db.propertyBlockedDate.delete({ where: { id: block.id } }); }
      await db.reservation.update({ where: { id: prior.id }, data: { checkOut: new Date("2026-10-01T10:15Z") } });
      await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/);
      await db.reservation.update({ where: { id: prior.id }, data: { checkOut: prior.checkOut } });
      // Cleaning for the arriving reservation cannot substitute for prior work.
      await db.cleaningWork.update({ where: { id: work.id }, data: { reservationId: stay.id } });
      await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/);
      await db.cleaningWork.update({ where: { id: work.id }, data: { reservationId: prior.id } });
      const duplicate = await db.cleaningWork.create({ data: { ...work, id: `${work.id}-other`, staffMemberId: `${staff.id}-other` } });
      try { await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/); }
      finally { await db.cleaningWork.delete({ where: { id: duplicate.id } }); }
      const changingPrior = await db.reservationModification.create({ data: {
        reservationId: prior.id, clientRequestId: "readiness-pending", requestFingerprint: "synthetic",
        status: "APPLYING", financialAction: "NO_PAYMENT_REQUIRED", baseReservationUpdatedAt: prior.updatedAt,
        currentCheckIn: prior.checkIn, currentCheckOut: prior.checkOut, proposedCheckIn: prior.checkIn,
        proposedCheckOut: new Date("2026-10-01T11:30Z"), currentAdults: 1, currentChildren: 0,
        proposedAdults: 1, proposedChildren: 0, currentPricing: {}, proposedPricing: {},
        currentTotalAmount: 10, proposedTotalAmount: 10, amountDifference: 0,
      } });
      try { await assert.rejects(early(), /ARRIVAL_READINESS_REQUIRED/); }
      finally { await db.reservationModification.delete({ where: { id: changingPrior.id } }); }
      await early();
      assert.equal((await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } })).completionConfirmedAt?.toISOString(), completed.toISOString());
    } finally {
      await db.cleaningWork.delete({ where: { id: work.id } });
      await db.cleaningConfirmation.delete({ where: { id: confirmation.id } });
      await db.propertyStaff.delete({ where: { id: assignment.id } });
      await db.staffMember.delete({ where: { id: staff.id } });
      await db.reservation.delete({ where: { id: prior.id } });
    }
  });
  await t.test("existing overlap and cleaning offset collision block; exact boundary allows", async () => {
    const conflict = await conflictStay("2026-10-03T19:45Z", "2026-10-04T15:00Z");
    await assert.rejects(estimate(), /TURNOVER_CONFLICT/);
    await db.reservation.update({ where: { id: conflict.id }, data: { checkIn: new Date("2026-10-03T20:00Z") } });
    await estimate();
    await db.reservation.update({ where: { id: conflict.id }, data: { checkIn: new Date("2026-10-02T19:00Z") } });
    await assert.rejects(estimate(), /TURNOVER_CONFLICT/);
    await db.reservation.update({ where: { id: conflict.id }, data: { status: "CANCELLED" } });
    await estimate();
    await db.reservation.delete({ where: { id: conflict.id } });
  });
  await t.test("host blocks reserve the extended cleaning window", async () => {
    const block = await db.propertyBlockedDate.create({ data: { propertyId: property.id,
      startDate: new Date("2026-10-03T19:59Z"), endDate: new Date("2026-10-04T15:00Z") } });
    await assert.rejects(estimate(), /TURNOVER_CONFLICT/);
    await db.propertyBlockedDate.delete({ where: { id: block.id } });
  });
  await t.test("payment processing, applying and unexpired holds block; expired hold does not", async () => {
    const other = await conflictStay("2026-10-05T19:00Z", "2026-10-06T15:00Z");
    const hold = await db.reservationModification.create({ data: {
      reservationId: other.id, clientRequestId: "synthetic-hold", requestFingerprint: "synthetic",
      status: "PAYMENT_PROCESSING", financialAction: "ADDITIONAL_PAYMENT_REQUIRED", baseReservationUpdatedAt: other.updatedAt,
      currentCheckIn: other.checkIn, currentCheckOut: other.checkOut,
      proposedCheckIn: new Date("2026-10-03T19:45Z"), proposedCheckOut: other.checkOut,
      currentAdults: 1, currentChildren: 0, proposedAdults: 1, proposedChildren: 0,
      currentPricing: {}, proposedPricing: {}, currentTotalAmount: 10, proposedTotalAmount: 20, amountDifference: 10,
      checkoutExpiresAt: new Date(now.getTime() - 1),
    } });
    await assert.rejects(estimate(), /TURNOVER_CONFLICT/);
    await db.reservationModification.update({ where: { id: hold.id }, data: { status: "APPLYING" } });
    await assert.rejects(estimate(), /TURNOVER_CONFLICT/);
    await db.reservationModification.update({ where: { id: hold.id }, data: { status: "AWAITING_PAYMENT" } });
    await estimate();
    await db.reservationModification.update({ where: { id: hold.id }, data: { checkoutExpiresAt: new Date(now.getTime() + 1) } });
    await assert.rejects(estimate(), /TURNOVER_CONFLICT/);
    await db.reservationModification.update({ where: { id: hold.id }, data: { reservationId: stay.id,
      proposedCheckIn: other.checkIn, status: "PAYMENT_PROCESSING" } });
    await assert.rejects(estimate(), /RESERVATION_CHANGE_IN_PROGRESS/);
    await db.reservationModification.update({ where: { id: hold.id }, data: { status: "APPLIED",
      currentCheckOut: stay.checkOut, proposedCheckOut: new Date("2026-10-03T16:00Z") } });
    await assert.rejects(estimate(), /REPEATED_ADJUSTMENT_REQUIRES_REVIEW/);
    await db.reservationModification.delete({ where: { id: hold.id } });
    await db.reservation.delete({ where: { id: other.id } });
  });
  await t.test("settings edits, disabled defaults, corrupt stored policy and inactive property fail closed", async () => {
    await db.property.update({ where: { id: property.id }, data: { stayTimeSettings: Prisma.DbNull } });
    await assert.rejects(estimate(), /SERVICE_DISABLED/);
    await db.property.update({ where: { id: property.id }, data: { stayTimeSettings: {} } });
    await assert.rejects(estimate(), /STAY_TIME_SETTINGS_INVALID/);
    await db.property.update({ where: { id: property.id }, data: { stayTimeSettings: enabled, status: "INACTIVE" } });
    await assert.rejects(estimate(), /NOT_FOUND/);
    await db.property.update({ where: { id: property.id }, data: { status: "ACTIVE", checkOutTime: "15:00" } });
    await assert.rejects(estimate(), /STAY_TIME_LIMIT_OUTSIDE_PROPERTY_HOURS/);
  });
});
