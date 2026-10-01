import { Prisma, type PrismaClient } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { planStayTimeAdjustment, StayTimePolicyError, type StayTimeOperation } from "../pin-ai/actions/stay-time-policy.js";
import { defaultStayTimeSettings, parseStayTimeSettings, validateStayTimeSettingsLimits } from "../pin-ai/actions/stay-time-settings.js";
import { readArrivalCleaningReadiness } from "./arrival-cleaning-readiness.service.js";
import { deriveStayTimeHourlyBasis } from "./stay-time-hourly-basis.js";

function reject(code: string): never { throw new StayTimePolicyError(code); }

/** Resolve a property-local clock time; never silently choose one side of a DST fold. */
export function resolveStayTimeClock(anchor: Date, localTime: string, timezone: string): Date {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) reject("INVALID_LOCAL_TIME");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(anchor); }
  catch { reject("INVALID_TIMEZONE"); }
  if (!timezone) reject("INVALID_TIMEZONE");
  const local = `${formatInTimeZone(anchor, timezone, "yyyy-MM-dd")}T${localTime}:00`;
  const guess = fromZonedTime(local, timezone);
  const offsets = new Set<string>();
  // Sample both sides of the transition, including non-hour DST offsets.
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(formatInTimeZone(new Date(guess.getTime() + hours * 3_600_000), timezone, "xxx"));
  }
  const matches = [...offsets].map(offset => new Date(local + offset))
    .filter(date => formatInTimeZone(date, timezone, "yyyy-MM-dd'T'HH:mm:ss") === local);
  if (matches.length === 0) reject("NONEXISTENT_LOCAL_TIME");
  if (matches.length !== 1) reject("AMBIGUOUS_LOCAL_TIME");
  return matches[0]!;
}

export type StayTimeEstimateRequest = Readonly<{
  /** Trusted authenticated context, never copied from model arguments. */
  organizationId: string;
  propertyId: string;
  reservationId: string;
  operation: StayTimeOperation;
  requestedLocalTime: string;
}>;

/**
 * Read-only estimate for a future authenticated runtime adapter. Not a hold,
 * proposal, final tax-inclusive price, or authorization to modify the stay.
 */
export async function estimateStayTimeAdjustment(
  db: Pick<PrismaClient, "$transaction">,
  input: StayTimeEstimateRequest,
  now = new Date(),
) {
  return db.$transaction(tx => estimateStayTimeAdjustmentInTransaction(tx, input, now), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 10000,
  });
}

/** Reuse an existing read snapshot when binding estimate and financial terms. */
export async function estimateStayTimeAdjustmentInTransaction(
  tx: Prisma.TransactionClient, input: StayTimeEstimateRequest, now: Date, ownModificationId?: string,
) {
  if (![input.organizationId, input.propertyId, input.reservationId].every(value => typeof value === "string" && value.trim())) {
    reject("SCOPE_MISMATCH");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject("INVALID_STAY_TIME");
  if (input.operation !== "EARLY_CHECKIN" && input.operation !== "LATE_CHECKOUT") reject("INVALID_OPERATION");
    const row = await tx.reservation.findFirst({
      where: { id: input.reservationId, propertyId: input.propertyId, status: "ACTIVE",
        property: { organizationId: input.organizationId, status: "ACTIVE" } },
      select: { id: true, propertyId: true, status: true, paymentState: true, source: true,
        externalProvider: true, currency: true, checkIn: true, checkOut: true, updatedAt: true, pricingBreakdown: true,
        property: { select: { timezone: true, checkInTime: true, checkOutTime: true,
          stayTimeSettings: true, stayTimeSettingsRevision: true, cleaningStartOffsetMinutes: true,
          cleaningDurationMinutes: true, updatedAt: true } } },
    });
    if (!row) reject("STAY_TIME_RESERVATION_NOT_FOUND");
    if (row.paymentState !== "PAID") reject("INELIGIBLE_RESERVATION");
    if ((row.externalProvider !== null && row.externalProvider !== "PIN_GO_DIRECT") ||
        (row.source !== "DIRECT_BOOKING" && row.externalProvider !== "PIN_GO_DIRECT")) reject("DIRECT_BOOKING_REQUIRED");
    const property = row.property;
    const settings = property.stayTimeSettings === null ? defaultStayTimeSettings() : parseStayTimeSettings(property.stayTimeSettings);
    validateStayTimeSettingsLimits(settings, property.checkInTime ?? "15:00", property.checkOutTime ?? "11:00");
    const early = input.operation === "EARLY_CHECKIN";
    if (!(early ? settings.earlyCheckin : settings.lateCheckout).enabled) reject("SERVICE_DISABLED");
    const timezone = property.timezone ?? "";
    const requestedAt = resolveStayTimeClock(early ? row.checkIn : row.checkOut, input.requestedLocalTime, timezone);
    const hourlyPricingBasis = (early ? settings.earlyCheckin : settings.lateCheckout).fee.mode === "PER_HOUR"
      ? deriveStayTimeHourlyBasis({ operation: input.operation, checkIn: row.checkIn, checkOut: row.checkOut,
        timezone, standardCheckIn: property.checkInTime ?? "15:00", standardCheckOut: property.checkOutTime ?? "11:00",
        pricingBreakdown: row.pricingBreakdown }) : undefined;
    const scope = { organizationId: input.organizationId, propertyId: row.propertyId };
    const offset = property.cleaningStartOffsetMinutes;
    const duration = property.cleaningDurationMinutes;
    if (!early && (!Number.isInteger(offset) || offset < 0 || offset > 1440 ||
        !Number.isInteger(duration) || duration <= 0 || duration > 1440)) reject("INVALID_CLEANING_WINDOW");
    const coveredFrom = early ? requestedAt : row.checkOut;
    const coveredUntil = early ? row.checkIn : new Date(requestedAt.getTime() + (offset + duration) * 60_000);

    const pending = { OR: [
      { status: "PAYMENT_PROCESSING" as const }, { status: "APPLYING" as const },
      { status: "AWAITING_PAYMENT" as const, checkoutExpiresAt: { gt: now } },
    ] };
    // Only this authenticated stay's applying change or unexpired paid staging
    // may be excluded by an internal revalidator. Guest tools never supply an ID.
    if (ownModificationId && !await tx.reservationModification.findFirst({ where: {
      id: ownModificationId, reservationId: row.id, requestSource: "PIN_AI_GUEST_SERVICES",
      OR: [{ status: "APPLYING" }, { status: "AWAITING_PAYMENT", financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
        additionalChargeAmount: { gt: 0 }, checkoutExpiresAt: { gt: now } }],
    }, select: { id: true } })) reject("STAY_TIME_MODIFICATION_SCOPE_MISMATCH");
    const excludeOwn = ownModificationId ? { id: { not: ownModificationId } } : {};
    // A second operation on this same stay is unsafe even if its hold doesn't
    // overlap the extra interval. Confirmation/payment may still change its base.
    const ownPending = await tx.reservationModification.findFirst({
      where: { reservationId: row.id, ...pending, ...excludeOwn }, select: { id: true },
    });
    if (ownPending) reject("RESERVATION_CHANGE_IN_PROGRESS");
    const history = await tx.reservationModification.findMany({
      where: { reservationId: row.id, status: "APPLIED" }, take: 101,
      orderBy: { createdAt: "desc" },
      select: { currentCheckIn: true, proposedCheckIn: true, currentCheckOut: true, proposedCheckOut: true },
    });
    if (history.length > 100) reject("ADJUSTMENT_HISTORY_REQUIRES_REVIEW");
    const adjustedOperations: StayTimeOperation[] = [];
    for (const change of history) {
      const sameDay = (a: Date, b: Date) => formatInTimeZone(a, timezone, "yyyy-MM-dd") === formatInTimeZone(b, timezone, "yyyy-MM-dd");
      if (change.proposedCheckIn < change.currentCheckIn && sameDay(change.proposedCheckIn, change.currentCheckIn)) adjustedOperations.push("EARLY_CHECKIN");
      if (change.proposedCheckOut > change.currentCheckOut && sameDay(change.proposedCheckOut, change.currentCheckOut)) adjustedOperations.push("LATE_CHECKOUT");
    }
    const occupied = await tx.reservation.findFirst({
      where: { id: { not: row.id }, propertyId: row.propertyId,
        property: { organizationId: input.organizationId }, status: "ACTIVE",
        checkIn: { lt: coveredUntil }, checkOut: { gt: coveredFrom } },
      select: { checkIn: true, checkOut: true },
    });
    const blocked = await tx.propertyBlockedDate.findFirst({
      where: { propertyId: row.propertyId, property: { organizationId: input.organizationId },
        startDate: { lt: coveredUntil }, endDate: { gt: coveredFrom } },
      select: { startDate: true, endDate: true },
    });
    const held = await tx.reservationModification.findFirst({
      where: { ...excludeOwn, reservation: { propertyId: row.propertyId, property: { organizationId: input.organizationId } },
        proposedCheckIn: { lt: coveredUntil }, proposedCheckOut: { gt: coveredFrom }, ...pending },
      select: { proposedCheckIn: true, proposedCheckOut: true },
    });
    const conflicts = [
      ...(occupied ? [{ startsAt: occupied.checkIn, endsAt: occupied.checkOut }] : []),
      ...(blocked ? [{ startsAt: blocked.startDate, endsAt: blocked.endDate }] : []),
      ...(held ? [{ startsAt: held.proposedCheckIn, endsAt: held.proposedCheckOut }] : []),
    ];
    const arrivalReadiness = early ? await readArrivalCleaningReadiness(tx, {
      ...scope, reservationId: row.id, checkIn: row.checkIn, requestedAt, now,
      cleaningStartOffsetMinutes: offset,
      ownModificationId,
    }) : null;
    const plan = planStayTimeAdjustment({ operation: input.operation, requestedAt, now,
      reservation: { ...scope, ...row, currency: row.currency?.toUpperCase() ?? "", adjustedOperations,
        ...(hourlyPricingBasis ? { hourlyPricingBasis } : {}) },
      policy: { ...scope, version: `stay-time-v1:${property.stayTimeSettingsRevision}:${property.updatedAt.toISOString()}`,
        timezone, ...settings, cleaningStartOffsetMinutes: offset, cleaningDurationMinutes: duration },
      evidence: { ...scope, reservationId: row.id, checkedAt: now, coveredFrom, coveredUntil, conflicts,
        arrivalReadiness },
    });
    return { ...plan, decision: "ESTIMATE_ONLY" as const, reservationUpdatedAt: row.updatedAt.toISOString(),
      arrivalReadinessEvidenceId: arrivalReadiness?.evidenceId ?? null,
      settingsRevision: property.stayTimeSettingsRevision, estimatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), availabilityHeld: false as const,
      executionAvailable: false as const, taxesIncluded: false as const };
}
