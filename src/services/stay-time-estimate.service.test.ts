import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { estimateStayTimeAdjustment, resolveStayTimeClock } from "./stay-time-estimate.service.js";
import { defaultStayTimeSettings } from "../pin-ai/actions/stay-time-settings.js";

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
    lateCheckout: { ...settings.lateCheckout, enabled: true, fee: { mode: "PER_HOUR", amountMinor: 1001, currency: "USD" } } };
  const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic estimate property",
    timezone: "America/Puerto_Rico", checkInTime: "15:00", checkOutTime: "11:00",
    cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180, stayTimeSettings: enabled } });
  t.after(async () => {
    try {
      await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
      await db.reservation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
      await db.property.delete({ where: { id: property.id } });
      await db.organization.delete({ where: { id: org.id } });
    } finally { await db.$disconnect(); }
  });
  const now = new Date("2026-10-01T12:00:00Z");
  const stay = await db.reservation.create({ data: { propertyId: property.id, guestName: "Synthetic guest",
    checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
    status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", currency: "usd" } });
  const input = { organizationId: org.id, propertyId: property.id, reservationId: stay.id,
    operation: "LATE_CHECKOUT" as const, requestedLocalTime: "12:30" };
  const estimate = () => estimateStayTimeAdjustment(db, input, now);
  const conflictStay = async (checkIn: string, checkOut: string) => db.reservation.create({ data: {
    propertyId: property.id, guestName: "Synthetic conflict", checkIn: new Date(checkIn), checkOut: new Date(checkOut),
  } });
  await t.test("exact minute fee, offset plus cleaning window, estimate only, no mutation", async () => {
    const before = await db.reservation.findUniqueOrThrow({ where: { id: stay.id } });
    const result = await estimate();
    assert.equal(result.feeSubtotalMinor, 1502);
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
