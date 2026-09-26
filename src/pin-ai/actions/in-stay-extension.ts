import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** Pure domain foundation. No database, provider calls or authorization grants. */
export class InStayExtensionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InStayExtensionError";
  }
}

function reject(code: string): never {
  throw new InStayExtensionError(code);
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function dateKey(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) reject("INVALID_EXTENSION_DATE");
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    reject("INVALID_EXTENSION_DATE");
  }
  return timestamp;
}

function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_EXTENSION_AMOUNT");
  return value;
}

function safeSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(cents(value)), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) reject("EXTENSION_AMOUNT_OVERFLOW");
  return Number(total);
}

function safeMultiply(amount: number, count: number): number {
  const total = BigInt(cents(amount)) * BigInt(cents(count));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) reject("EXTENSION_AMOUNT_OVERFLOW");
  return Number(total);
}

export type InStayExtensionReservation = Readonly<{
  status: string;
  paymentState: string;
  source: string | null;
  externalProvider: string | null;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  selectedAmenityIds: readonly string[];
}>;

export function planInStayExtension(input: Readonly<{
  reservation: InStayExtensionReservation;
  proposedCheckOutDate: string;
  propertyTimezone: string;
  propertyCheckOutTime: string;
  maximumNights: number | null;
  now: Date;
}>) {
  const reservation = input.reservation;
  if (![reservation.checkIn, reservation.checkOut, input.now].every(validDate) ||
      reservation.checkOut <= reservation.checkIn) reject("INVALID_CURRENT_STAY");
  if (reservation.source !== "DIRECT_BOOKING" && reservation.externalProvider !== "PIN_GO_DIRECT") {
    reject("NOT_DIRECT_BOOKING_RESERVATION");
  }
  if (reservation.status !== "ACTIVE" || reservation.paymentState !== "PAID") {
    reject("RESERVATION_NOT_ELIGIBLE_FOR_EXTENSION");
  }
  if (input.now < reservation.checkIn) reject("EXTENSION_REQUIRES_IN_STAY");
  if (input.now >= reservation.checkOut) reject("CURRENT_STAY_ENDED");
  if (!input.propertyTimezone.trim() ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.propertyCheckOutTime)) {
    reject("INVALID_EXTENSION_PROPERTY_TIME");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.propertyTimezone }).format(input.now);
  } catch {
    reject("INVALID_EXTENSION_PROPERTY_TIME");
  }
  if (!Number.isSafeInteger(reservation.adults) || reservation.adults < 1 ||
      !Number.isSafeInteger(reservation.children) || reservation.children < 0 ||
      reservation.selectedAmenityIds.some((id) => typeof id !== "string" || !id.trim()) ||
      new Set(reservation.selectedAmenityIds).size !== reservation.selectedAmenityIds.length) {
    reject("INVALID_CURRENT_GUEST_CONFIGURATION");
  }
  const startKey = formatInTimeZone(reservation.checkOut, input.propertyTimezone, "yyyy-MM-dd");
  const checkInKey = formatInTimeZone(reservation.checkIn, input.propertyTimezone, "yyyy-MM-dd");
  const endDay = dateKey(input.proposedCheckOutDate);
  const startDay = dateKey(startKey);
  if (endDay <= startDay) reject("CHECKOUT_EXTENSION_REQUIRED");
  const additionalNights = (endDay - startDay) / 86_400_000;
  const totalNights = (endDay - dateKey(checkInKey)) / 86_400_000;
  if (input.maximumNights !== null) {
    if (!Number.isSafeInteger(input.maximumNights) || input.maximumNights < 1) {
      reject("INVALID_MAXIMUM_STAY");
    }
    if (totalNights > input.maximumNights) reject("MAXIMUM_STAY_EXCEEDED");
  }
  // Bound untrusted date ranges before building arrays, independently of property rules.
  if (additionalNights > 3660) reject("EXTENSION_RANGE_TOO_LARGE");
  const localCheckout = `${input.proposedCheckOutDate}T${input.propertyCheckOutTime}:00`;
  const proposedCheckOut = fromZonedTime(localCheckout, input.propertyTimezone);
  if (!validDate(proposedCheckOut) || proposedCheckOut <= reservation.checkOut ||
      formatInTimeZone(proposedCheckOut, input.propertyTimezone, "yyyy-MM-dd'T'HH:mm:ss") !== localCheckout) {
    reject("INVALID_EXTENSION_PROPERTY_TIME");
  }
  const additionalNightDates = Array.from({ length: additionalNights }, (_, offset) =>
    new Date(startDay + offset * 86_400_000).toISOString().slice(0, 10));
  return Object.freeze({
    operation: "EXTEND_CHECKOUT_ONLY" as const,
    managementPhase: "IN_STAY" as const,
    // Preserve the persisted instant, including early/custom check-in hours.
    checkIn: reservation.checkIn.toISOString(),
    currentCheckOut: reservation.checkOut.toISOString(),
    proposedCheckOut: proposedCheckOut.toISOString(),
    adults: reservation.adults,
    children: reservation.children,
    selectedAmenityIds: Object.freeze([...reservation.selectedAmenityIds]),
    additionalNightDates: Object.freeze(additionalNightDates),
    additionalNights,
    totalNights,
    propertyTimezone: input.propertyTimezone,
  });
}

export type InStayExtensionPlan = ReturnType<typeof planInStayExtension>;

/** Server-supplied prices for exactly the added nights, never the complete stay. */
export function quoteInStayExtension(input: Readonly<{
  plan: InStayExtensionPlan;
  currentTotalAmountCents: number;
  currency: string;
  pricingCurrency: string;
  nightlyRates: readonly Readonly<{ date: string; amountCents: number }>[];
  amenities: readonly Readonly<{
    id: string;
    chargeMode: "INCLUDED" | "REQUIRED" | "OPTIONAL";
    feeType: "PER_NIGHT" | "PER_STAY" | "PER_GUEST" | "PER_GUEST_PER_NIGHT";
    unitAmountCents: number;
  }>[];
  taxes: readonly Readonly<{ id: string; rateBasisPoints: number }>[];
}>) {
  const currentTotalAmountCents = cents(input.currentTotalAmountCents);
  if (currentTotalAmountCents === 0) reject("CURRENT_RESERVATION_TOTAL_INVALID");
  // The existing canonical pricing engine currently returns USD only.
  if (input.currency.toLowerCase() !== "usd" || input.pricingCurrency.toLowerCase() !== "usd") {
    reject("EXTENSION_CURRENCY_UNSUPPORTED");
  }
  const expected = input.plan.additionalNightDates;
  if (input.nightlyRates.length !== expected.length ||
      new Set(input.nightlyRates.map((rate) => rate.date)).size !== expected.length ||
      input.nightlyRates.some((rate) => !expected.includes(rate.date))) {
    reject("EXTENSION_NIGHTLY_RATES_MISMATCH");
  }
  const nightlySubtotalCents = safeSum(input.nightlyRates.map((rate) => rate.amountCents));
  const selected = new Set(input.plan.selectedAmenityIds);
  const amenityIds = new Set(input.amenities.map((item) => item.id));
  if (amenityIds.size !== input.amenities.length ||
      input.amenities.some((item) => !item.id.trim()) ||
      [...selected].some((id) => !amenityIds.has(id))) reject("EXTENSION_AMENITIES_MISMATCH");
  const amenities = input.amenities.map((item) => {
    cents(item.unitAmountCents);
    if (!["INCLUDED", "REQUIRED", "OPTIONAL"].includes(item.chargeMode) ||
        !["PER_NIGHT", "PER_STAY", "PER_GUEST", "PER_GUEST_PER_NIGHT"].includes(item.feeType)) {
      reject("INVALID_EXTENSION_AMENITY");
    }
    // Per-guest fee semantics need a canonical contract before enabling them.
    if ((item.chargeMode === "REQUIRED" || (item.chargeMode === "OPTIONAL" && selected.has(item.id))) &&
        (item.feeType === "PER_GUEST" || item.feeType === "PER_GUEST_PER_NIGHT")) {
      reject("EXTENSION_AMENITY_REVIEW_REQUIRED");
    }
    const chargeable = item.feeType === "PER_NIGHT" &&
      (item.chargeMode === "REQUIRED" || (item.chargeMode === "OPTIONAL" && selected.has(item.id)));
    return Object.freeze({ id: item.id, amountCents: chargeable
      ? safeMultiply(item.unitAmountCents, input.plan.additionalNights) : 0 });
  });
  const amenitiesTotalCents = safeSum(amenities.map((item) => item.amountCents));
  const taxableSubtotalCents = safeSum([nightlySubtotalCents, amenitiesTotalCents]);
  if (new Set(input.taxes.map((tax) => tax.id)).size !== input.taxes.length ||
      input.taxes.some((tax) => !tax.id.trim())) reject("INVALID_EXTENSION_TAX");
  const taxes = input.taxes.map((tax) => {
    if (!Number.isSafeInteger(tax.rateBasisPoints) || tax.rateBasisPoints < 0 || tax.rateBasisPoints > 10_000) {
      reject("INVALID_EXTENSION_TAX");
    }
    // Match per-tax rounding to cents without floating-point arithmetic.
    const amount = (BigInt(taxableSubtotalCents) * BigInt(tax.rateBasisPoints) + 5_000n) / 10_000n;
    return Object.freeze({ id: tax.id, rateBasisPoints: tax.rateBasisPoints, amountCents: Number(amount) });
  });
  const taxesTotalCents = safeSum(taxes.map((tax) => tax.amountCents));
  const amountDifferenceCents = safeSum([taxableSubtotalCents, taxesTotalCents]);
  return Object.freeze({
    operation: input.plan.operation,
    pricingBasis: "PERSISTED_TOTAL_PLUS_ADDITIONAL_NIGHTS_V1" as const,
    currency: "usd" as const,
    currentTotalAmountCents,
    nightlySubtotalCents,
    cleaningFeeCents: 0 as const,
    amenities: Object.freeze(amenities),
    amenitiesTotalCents,
    taxes: Object.freeze(taxes),
    taxesTotalCents,
    amountDifferenceCents,
    proposedTotalAmountCents: safeSum([currentTotalAmountCents, amountDifferenceCents]),
    financialAction: amountDifferenceCents > 0 ? "ADDITIONAL_PAYMENT_REQUIRED" : "NO_PAYMENT_REQUIRED",
    authorizationGranted: false as const,
    actionExecuted: false as const,
    availabilityHeld: false as const,
  });
}
