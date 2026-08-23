import type { ChannexAriRatesRestrictionsChangedField } from "./channex-ari-rates-restrictions-snapshot.policy";

const RATE_BOOLEAN_FIELDS = [
  "dynamicPricingEnabled",
  "seasonalPricingEnabled",
  "holidayPricingEnabled",
  "leadTimePricingEnabled",
  "occupancyPricingEnabled",
] as const;

const RATE_NUMBER_FIELDS = [
  "baseNightlyRate",
  "minimumNightlyRate",
  "maximumNightlyRate",
  "weekendMarkupPercent",
  "leadTimeLastMinuteDays",
  "leadTimeLastMinutePercent",
  "occupancyLookaheadDays",
  "occupancyLowThresholdPercent",
  "occupancyLowAdjustmentPercent",
  "occupancyHighThresholdPercent",
  "occupancyHighAdjustmentPercent",
] as const;

function owns(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function comparableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberChanged(input: {
  existing: Record<string, unknown>;
  changes: Record<string, unknown>;
  field: string;
}): boolean {
  return (
    owns(input.changes, input.field) &&
    comparableNumber(input.changes[input.field]) !==
      comparableNumber(input.existing[input.field])
  );
}

export function resolveChannexAriPropertyChangedFields(input: {
  existing: Record<string, unknown>;
  changes: Record<string, unknown>;
}): ChannexAriRatesRestrictionsChangedField[] {
  const changedFields: ChannexAriRatesRestrictionsChangedField[] = [];
  const rateChanged =
    RATE_BOOLEAN_FIELDS.some(
      (field) =>
        owns(input.changes, field) &&
        Boolean(input.changes[field]) !== Boolean(input.existing[field])
    ) ||
    RATE_NUMBER_FIELDS.some((field) =>
      numberChanged({ ...input, field })
    );

  if (rateChanged) changedFields.push("rate");

  if (numberChanged({ ...input, field: "minimumNights" })) {
    changedFields.push("minStayArrival", "minStayThrough");
  }

  if (numberChanged({ ...input, field: "maximumNights" })) {
    changedFields.push("maxStay");
  }

  return changedFields;
}
