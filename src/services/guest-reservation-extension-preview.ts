import { formatInTimeZone } from "date-fns-tz";
import {
  InStayExtensionError,
  planInStayExtension,
  quoteInStayExtension,
  type InStayExtensionReservation,
} from "../pin-ai/actions/in-stay-extension.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_REQUIRED");
  }
  return value as RecordValue;
}
function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_INVALID");
  }
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result)) throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_INVALID");
  return result;
}
function rows(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_INVALID");
  return value.map(record);
}

export type ExtensionPricingResult = Readonly<{
  currency: string;
  nightlyRates: readonly Readonly<{ date: string; rate: number }>[];
  amenities: readonly Readonly<{
    id: string; name?: string; chargeMode: "INCLUDED" | "REQUIRED" | "OPTIONAL";
    feeType: "PER_STAY" | "PER_NIGHT" | "PER_GUEST" | "PER_GUEST_PER_NIGHT";
    baseAmount: number;
  }>[];
  taxes: readonly Readonly<{ id: string; name?: string; percentage: number }>[];
}>;

export type ExtensionPreviewInput = Readonly<{
  reservation: InStayExtensionReservation & Readonly<{
    id: string; propertyId: string; currency: string; totalAmount: number; pricingBreakdown: unknown;
  }>;
  proposedCheckIn: Date;
  proposedCheckOut: Date;
  proposedAdults: number;
  proposedChildren: number;
  proposedSelectedAmenityIds: readonly string[];
  propertyTimezone: string;
  propertyCheckOutTime: string;
  maximumNights: number | null;
  now: Date;
}>;

/** Dependency-injected canonical extension preview. Reads only; no proposal/payment writes. */
export async function previewGuestReservationExtension(
  input: ExtensionPreviewInput,
  dependencies: Readonly<{
    checkAvailability: (input: Readonly<{
      propertyId: string; checkIn: Date; checkOut: Date; excludeReservationId: string;
    }>) => Promise<Readonly<{ available: boolean }>>;
    calculatePricing: (input: Readonly<{
      propertyId: string; checkIn: Date; checkOut: Date; selectedAmenityIds: string[];
      excludeReservationId: string; includeAuditEntries: false;
    }>) => Promise<ExtensionPricingResult>;
  }>,
) {
  const current = input.reservation;
  if (input.proposedCheckIn.getTime() !== current.checkIn.getTime() ||
      input.proposedAdults !== current.adults || input.proposedChildren !== current.children ||
      JSON.stringify([...input.proposedSelectedAmenityIds].sort()) !== JSON.stringify([...current.selectedAmenityIds].sort())) {
    throw new InStayExtensionError("EXTENSION_MUST_PRESERVE_CURRENT_STAY");
  }
  let proposedCheckOutDate: string;
  try {
    proposedCheckOutDate = formatInTimeZone(input.proposedCheckOut, input.propertyTimezone, "yyyy-MM-dd");
  } catch {
    throw new InStayExtensionError("INVALID_EXTENSION_PROPERTY_TIME");
  }
  const plan = planInStayExtension({ ...input, reservation: current, proposedCheckOutDate });
  if (plan.proposedCheckOut !== input.proposedCheckOut.toISOString()) {
    throw new InStayExtensionError("EXTENSION_CHECKOUT_TIME_MISMATCH");
  }
  const base = record(current.pricingBreakdown);
  const currentTotalAmountCents = money(current.totalAmount);
  const baseNightly = money(base.nightlySubtotal);
  const baseCleaning = money(base.cleaningFee);
  const baseAmenities = money(base.amenitiesTotal);
  const baseTaxes = money(base.taxesTotal);
  if (String(base.currency ?? "").toLowerCase() !== current.currency.toLowerCase() ||
      money(base.totalAmount) !== currentTotalAmountCents ||
      (base.totalAmountCents !== undefined && base.totalAmountCents !== currentTotalAmountCents) ||
      baseNightly + baseCleaning + baseAmenities + baseTaxes !== currentTotalAmountCents) {
    throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_MISMATCH");
  }
  const oldNights = rows(base.nightlyRates);
  const oldAmenities = rows(base.amenities);
  const oldTaxes = rows(base.taxes);
  const originalStart = formatInTimeZone(current.checkIn, input.propertyTimezone, "yyyy-MM-dd");
  const originalEnd = formatInTimeZone(current.checkOut, input.propertyTimezone, "yyyy-MM-dd");
  if (oldNights.length !== plan.totalNights - plan.additionalNights ||
      new Set(oldNights.map((item) => item.date)).size !== oldNights.length ||
      oldNights.some((item) => typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
        item.date < originalStart || item.date >= originalEnd ||
        !Number.isFinite(Date.parse(`${item.date}T00:00:00Z`)) ||
        new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date)) {
    throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_MISMATCH");
  }
  if (oldNights.reduce((sum, item) => sum + money(item.rate), 0) !== baseNightly ||
      oldAmenities.reduce((sum, item) => sum + money(item.amount), 0) !== baseAmenities ||
      oldTaxes.reduce((sum, item) => sum + money(item.amount), 0) !== baseTaxes) {
    throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_MISMATCH");
  }
  const availability = await dependencies.checkAvailability({
    propertyId: current.propertyId, checkIn: current.checkOut,
    checkOut: input.proposedCheckOut, excludeReservationId: current.id,
  });
  if (!availability.available) throw new InStayExtensionError("PROPERTY_NOT_AVAILABLE_FOR_SELECTED_DATES");
  // The rate engine uses UTC date keys. Supply local calendar keys, not offset instants.
  const additionalPricing = await dependencies.calculatePricing({
    propertyId: current.propertyId,
    checkIn: new Date(`${plan.additionalNightDates[0]}T00:00:00.000Z`),
    checkOut: new Date(`${proposedCheckOutDate}T00:00:00.000Z`),
    selectedAmenityIds: [...current.selectedAmenityIds], excludeReservationId: current.id,
    includeAuditEntries: false,
  });
  const quote = quoteInStayExtension({
    plan, currentTotalAmountCents, currency: current.currency, pricingCurrency: additionalPricing.currency,
    nightlyRates: additionalPricing.nightlyRates.map((item) => ({ date: item.date, amountCents: money(item.rate) })),
    amenities: additionalPricing.amenities.map((item) => ({
      id: item.id, chargeMode: item.chargeMode, feeType: item.feeType, unitAmountCents: money(item.baseAmount),
    })),
    taxes: additionalPricing.taxes.map((item) => ({ id: item.id, rateBasisPoints: money(item.percentage) })),
  });
  function mergeAmounts(old: RecordValue[], added: readonly Readonly<{ id: string; amountCents: number }>[], metadata: readonly { id: string }[]) {
    if (old.some((item) => typeof item.id !== "string") || new Set(old.map((item) => item.id)).size !== old.length) {
      throw new InStayExtensionError("EXTENSION_PRICING_SNAPSHOT_INVALID");
    }
    const merged: Array<RecordValue & { amount: number }> = old.map((item) => ({ ...item, amount: (money(item.amount) + (added.find((extra) => extra.id === item.id)?.amountCents ?? 0)) / 100 }));
    for (const extra of added) {
      if (!old.some((item) => item.id === extra.id) && extra.amountCents > 0) {
        merged.push({ ...metadata.find((item) => item.id === extra.id), id: extra.id, amount: extra.amountCents / 100 });
      }
    }
    return merged;
  }
  const amenities = mergeAmounts(oldAmenities, quote.amenities, additionalPricing.amenities);
  const taxes = mergeAmounts(oldTaxes, quote.taxes, additionalPricing.taxes);
  const extensionSnapshot = {
    operation: plan.operation, pricingBasis: quote.pricingBasis,
    currentCheckOut: plan.currentCheckOut, proposedCheckOut: plan.proposedCheckOut,
    nightlyRates: additionalPricing.nightlyRates.map(({ date, rate }) => ({ date, rate })),
    amenities: quote.amenities, taxes: quote.taxes, amountDifferenceCents: quote.amountDifferenceCents,
  };
  return {
    plan, quote,
    proposedPricing: {
      ...base, currency: quote.currency, nights: plan.totalNights,
      nightlyRates: [...oldNights, ...extensionSnapshot.nightlyRates],
      nightlySubtotal: (baseNightly + quote.nightlySubtotalCents) / 100,
      cleaningFee: baseCleaning / 100,
      amenities, chargedAmenities: amenities.filter((item) => item.amount > 0),
      amenitiesTotal: (baseAmenities + quote.amenitiesTotalCents) / 100,
      taxableSubtotal: (baseNightly + baseCleaning + baseAmenities + quote.nightlySubtotalCents + quote.amenitiesTotalCents) / 100,
      taxes, taxesTotal: (baseTaxes + quote.taxesTotalCents) / 100,
      totalAmount: quote.proposedTotalAmountCents / 100, totalAmountCents: quote.proposedTotalAmountCents,
      extensionQuotes: [...(Array.isArray(base.extensionQuotes) ? base.extensionQuotes : []), extensionSnapshot],
    },
  };
}
