import { formatInTimeZone } from "date-fns-tz";

/** Server-side planning only. Callers must obtain fresh, scoped canonical evidence. */
export type StayTimeOperation = "EARLY_CHECKIN" | "LATE_CHECKOUT";
export type StayTimeFee = Readonly<{
  mode: "FREE" | "FIXED" | "PER_HOUR";
  amountMinor: number;
  currency: string;
}>;
export type StayTimeRule = Readonly<{
  enabled: boolean;
  /** Earliest arrival / latest departure, in the property's local timezone. */
  limitLocalTime: string;
  fee: StayTimeFee;
}>;
type Scope = Readonly<{ organizationId: string; propertyId: string }>;
export type StayTimePolicy = Scope & Readonly<{
  version: string;
  timezone: string;
  earlyCheckin: StayTimeRule;
  lateCheckout: StayTimeRule;
  cleaningStartOffsetMinutes: number;
  cleaningDurationMinutes: number;
}>;
export type StayTimeReservation = Scope & Readonly<{
  id: string;
  status: string;
  paymentState: string;
  source: string | null;
  externalProvider: string | null;
  currency: string;
  checkIn: Date;
  checkOut: Date;
  /** Repeated adjustments need an incremental-pricing contract, outside V1. */
  adjustedOperations: readonly StayTimeOperation[];
}>;
export type StayTimeEvidence = Scope & Readonly<{
  reservationId: string;
  checkedAt: Date;
  /** Query coverage, including reservations, blocks and pending payment holds. */
  coveredFrom: Date;
  coveredUntil: Date;
  conflicts: readonly Readonly<{ startsAt: Date; endsAt: Date }>[];
  arrivalReadiness: null | Readonly<{
    arrivingReservationId: string;
    scheduledCheckIn: Date;
    status: "READY" | "NOT_READY" | "UNKNOWN";
    /** Set only by a canonical readiness resolver, not a model or request body. */
    evidenceId: string;
    assessedAt: Date;
  }>;
}>;

export class StayTimePolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StayTimePolicyError";
  }
}
function reject(code: string): never { throw new StayTimePolicyError(code); }
function validDate(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}
function validId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
function nonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function fresh(date: Date, now: Date): boolean {
  return validDate(date) && date <= now && now.getTime() - date.getTime() <= 60_000;
}
function localTimeMinutes(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) reject("INVALID_LOCAL_TIME");
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function validateFee(fee: StayTimeFee): void {
  if (!["FREE", "FIXED", "PER_HOUR"].includes(fee.mode) ||
      !nonnegativeInteger(fee.amountMinor) || !/^[A-Z]{3}$/.test(fee.currency) ||
      (fee.mode === "FREE" ? fee.amountMinor !== 0 : fee.amountMinor === 0)) {
    reject("INVALID_FEE_POLICY");
  }
}

/** Fees are in currency minor units. Hourly fees are prorated by elapsed minute. */
export function calculateStayTimeFee(fee: StayTimeFee, additionalMinutes: number): number {
  validateFee(fee);
  if (!Number.isSafeInteger(additionalMinutes) || additionalMinutes <= 0 || additionalMinutes > 1_500) {
    reject("INVALID_ADDITIONAL_MINUTES");
  }
  const amount = fee.mode === "FREE" ? 0n : fee.mode === "FIXED" ? BigInt(fee.amountMinor) :
    (BigInt(fee.amountMinor) * BigInt(additionalMinutes) + 30n) / 60n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) reject("FEE_OVERFLOW");
  // A positive paid rule must never silently become a free offer after rounding.
  if (fee.mode !== "FREE" && amount === 0n) reject("FEE_BELOW_MINOR_UNIT");
  return Number(amount);
}

export function planStayTimeAdjustment(input: Readonly<{
  operation: StayTimeOperation;
  requestedAt: Date;
  now: Date;
  reservation: StayTimeReservation;
  policy: StayTimePolicy;
  evidence: StayTimeEvidence;
}>) {
  const { operation, requestedAt, now, reservation, policy, evidence } = input;
  if (operation !== "EARLY_CHECKIN" && operation !== "LATE_CHECKOUT") reject("INVALID_OPERATION");
  if (![requestedAt, now, reservation.checkIn, reservation.checkOut].every(validDate) ||
      reservation.checkOut <= reservation.checkIn) reject("INVALID_STAY_TIME");
  if (![reservation.id, reservation.organizationId, reservation.propertyId, policy.version].every(validId) ||
      policy.organizationId !== reservation.organizationId || policy.propertyId !== reservation.propertyId ||
      evidence.organizationId !== reservation.organizationId || evidence.propertyId !== reservation.propertyId ||
      evidence.reservationId !== reservation.id) reject("SCOPE_MISMATCH");
  if (reservation.source !== "DIRECT_BOOKING" && reservation.externalProvider !== "PIN_GO_DIRECT") {
    reject("DIRECT_BOOKING_REQUIRED");
  }
  if (reservation.status !== "ACTIVE" || reservation.paymentState !== "PAID") reject("INELIGIBLE_RESERVATION");
  if (!Array.isArray(reservation.adjustedOperations) ||
      reservation.adjustedOperations.some(value => value !== "EARLY_CHECKIN" && value !== "LATE_CHECKOUT")) {
    reject("INVALID_ADJUSTMENT_HISTORY");
  }
  if (reservation.adjustedOperations.includes(operation)) reject("REPEATED_ADJUSTMENT_REQUIRES_REVIEW");
  if (!fresh(evidence.checkedAt, now)) reject("STALE_OPERATIONAL_EVIDENCE");
  try {
    if (!validId(policy.timezone)) reject("INVALID_TIMEZONE");
    new Intl.DateTimeFormat("en", { timeZone: policy.timezone }).format(now);
  } catch { reject("INVALID_TIMEZONE"); }

  const early = operation === "EARLY_CHECKIN";
  const rule = early ? policy.earlyCheckin : policy.lateCheckout;
  if (rule.enabled !== true) reject("SERVICE_DISABLED");
  const limit = localTimeMinutes(rule.limitLocalTime);
  validateFee(rule.fee);
  if (rule.fee.currency !== reservation.currency) reject("CURRENCY_MISMATCH");
  const currentAt = early ? reservation.checkIn : reservation.checkOut;
  if (now >= currentAt || now >= requestedAt) reject("REQUEST_WINDOW_CLOSED");
  if (formatInTimeZone(requestedAt, policy.timezone, "yyyy-MM-dd") !==
      formatInTimeZone(currentAt, policy.timezone, "yyyy-MM-dd")) reject("SAME_LOCAL_DAY_REQUIRED");
  const requestedMinutes = localTimeMinutes(formatInTimeZone(requestedAt, policy.timezone, "HH:mm"));
  if ((early && requestedMinutes < limit) || (!early && requestedMinutes > limit)) reject("HOST_TIME_LIMIT_EXCEEDED");
  const delta = early ? currentAt.getTime() - requestedAt.getTime() : requestedAt.getTime() - currentAt.getTime();
  if (delta <= 0) reject("INVALID_TIME_DIRECTION");
  // Minute precision avoids hidden seconds changing either the limit or the price.
  if (requestedAt.getUTCSeconds() || requestedAt.getUTCMilliseconds() ||
      currentAt.getUTCSeconds() || currentAt.getUTCMilliseconds()) reject("MINUTE_PRECISION_REQUIRED");
  const additionalMinutes = delta / 60_000;
  const feeSubtotalMinor = calculateStayTimeFee(rule.fee, additionalMinutes);

  let requiredFreeFrom = early ? requestedAt : currentAt;
  let requiredFreeUntil = early ? currentAt : requestedAt;
  if (!early) {
    if (!nonnegativeInteger(policy.cleaningStartOffsetMinutes) || policy.cleaningStartOffsetMinutes > 1_440 ||
        !Number.isSafeInteger(policy.cleaningDurationMinutes) || policy.cleaningDurationMinutes <= 0 ||
        policy.cleaningDurationMinutes > 1_440) reject("INVALID_CLEANING_WINDOW");
    requiredFreeUntil = new Date(requestedAt.getTime() +
      (policy.cleaningStartOffsetMinutes + policy.cleaningDurationMinutes) * 60_000);
    if (!validDate(requiredFreeUntil)) reject("INVALID_CLEANING_WINDOW");
  }
  if (!validDate(evidence.coveredFrom) || !validDate(evidence.coveredUntil) ||
      evidence.coveredFrom > requiredFreeFrom || evidence.coveredUntil < requiredFreeUntil ||
      !Array.isArray(evidence.conflicts)) reject("INCOMPLETE_AVAILABILITY_EVIDENCE");
  for (const conflict of evidence.conflicts) {
    if (!validDate(conflict.startsAt) || !validDate(conflict.endsAt) || conflict.endsAt <= conflict.startsAt) {
      reject("INVALID_AVAILABILITY_EVIDENCE");
    }
    if (conflict.startsAt < requiredFreeUntil && conflict.endsAt > requiredFreeFrom) reject("TURNOVER_CONFLICT");
  }
  if (early) {
    const readiness = evidence.arrivalReadiness;
    if (!readiness || readiness.arrivingReservationId !== reservation.id ||
        !validDate(readiness.scheduledCheckIn) || readiness.scheduledCheckIn.getTime() !== reservation.checkIn.getTime() ||
        !validId(readiness.evidenceId) || !fresh(readiness.assessedAt, now) || readiness.status !== "READY") {
      reject("ARRIVAL_READINESS_REQUIRED");
    }
  }
  return Object.freeze({
    operation,
    organizationId: reservation.organizationId,
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    policyVersion: policy.version,
    decision: "ELIGIBLE_FOR_PROPOSAL" as const,
    checkIn: (early ? requestedAt : reservation.checkIn).toISOString(),
    checkOut: (early ? reservation.checkOut : requestedAt).toISOString(),
    additionalMinutes,
    feeMode: rule.fee.mode,
    feeSubtotalMinor,
    currency: rule.fee.currency,
    requiredFreeFrom: requiredFreeFrom.toISOString(),
    requiredFreeUntil: requiredFreeUntil.toISOString(),
    requiresGuestConfirmation: true as const,
    // Tax, payment and proposal binding belong to the canonical execution layer.
    paymentReady: false as const,
    authorizationGranted: false as const,
    actionExecuted: false as const,
  });
}
