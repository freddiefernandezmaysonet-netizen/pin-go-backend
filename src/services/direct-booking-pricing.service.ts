import { PrismaClient } from "@prisma/client";
import type { DecisionStep } from "../apms/decision-types";
import { createRevenueAuditEntry } from "../apms/revenue-audit.mapper";

type PricingDecisionStep = DecisionStep<number>;

const prisma = new PrismaClient();

type CalculateDirectBookingPricingInput = {
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
  selectedAmenityIds?: string[];
};

function toMoney(value: unknown) {
  const number = Number(value ?? 0);
  return Math.round(number * 100) / 100;
}

function createPricingDecisionStep(input: {
  rule: string;
  label: string;
  previousRate: number;
  newRate: number;
  adjustmentPercent?: number | null;
}): DecisionStep<number> {
  const previousRate = toMoney(input.previousRate);
  const newRate = toMoney(input.newRate);

  return {
    engine: "Revenue",
    rule: input.rule,
    label: input.label,
    previousValue: previousRate,
    newValue: newRate,
    adjustment: toMoney(newRate - previousRate),
    adjustmentPercent: input.adjustmentPercent ?? null,
    confidence: 100,
    applied: newRate !== previousRate,
    status: newRate !== previousRate ? "APPLIED" : "SKIPPED",
    timestamp: new Date(),
    metadata: {
      previousRate,
      newRate,
    },
  };
}

export async function calculateDirectBookingPricing(
  input: CalculateDirectBookingPricingInput
) {
  const selectedAmenityIds = new Set(input.selectedAmenityIds ?? []);

  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: {
      id: true,
      baseNightlyRate: true,
      minimumNightlyRate: true,
      maximumNightlyRate: true,
      dynamicPricingEnabled: true,
      seasonalPricingEnabled: true,
      holidayPricingEnabled: true,
      weekendMarkupPercent: true,
      leadTimePricingEnabled: true,
      leadTimeLastMinuteDays: true,
      leadTimeLastMinutePercent: true,
      occupancyPricingEnabled: true,
      occupancyLookaheadDays: true,
      occupancyLowThresholdPercent: true,
      occupancyLowAdjustmentPercent: true,
      occupancyHighThresholdPercent: true,
      occupancyHighAdjustmentPercent: true,
      cleaningFee: true,
      amenities: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          chargeMode: true,
          feeType: true,
          amount: true,
        },
        orderBy: { name: "asc" },
      },
      taxes: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          percentage: true,
        },
        orderBy: { name: "asc" },
      },
    
    nightlyRates: {
  where: {
    date: {
      gte: startOfUtcDay(input.checkIn),
      lt: startOfUtcDay(input.checkOut),
    },
  },
  
 select: {
    date: true,
    rate: true,
    reason: true,
  },
},

seasons: {
  where: {
    isActive: true,
  },
  select: {
    name: true,
    startMonth: true,
    startDay: true,
    endMonth: true,
    endDay: true,
    adjustmentPercent: true,
    source: true,
  },
},

holidayPricings: {
  where: {
    isActive: true,
  },
  select: {
    name: true,
    startMonth: true,
    startDay: true,
    endMonth: true,
    endDay: true,
    adjustmentPercent: true,
    source: true,
  },
},

    },
  });

  if (!property) {
    throw new Error("DIRECT_BOOKING_PROPERTY_NOT_FOUND");
  }

  if (!property.baseNightlyRate) {
    throw new Error("Property is missing baseNightlyRate");
  }

  const nights = Math.ceil(
    (input.checkOut.getTime() - input.checkIn.getTime()) /
      (1000 * 60 * 60 * 24)
  );

  if (!Number.isFinite(nights) || nights <= 0) {
    throw new Error("Invalid number of nights");
  }

const occupancyReservations = await prisma.reservation.findMany({
  where: {
    propertyId: input.propertyId,
    status: "ACTIVE",
    checkIn: {
      lt: startOfUtcDay(input.checkOut),
    },
    checkOut: {
      gt: startOfUtcDay(input.checkIn),
    },
  },
  select: {
    checkIn: true,
    checkOut: true,
  },
});

const occupancyBlockedDates = await prisma.propertyBlockedDate.findMany({
  where: {
    propertyId: input.propertyId,
    startDate: {
      lt: startOfUtcDay(input.checkOut),
    },
    endDate: {
      gt: startOfUtcDay(input.checkIn),
    },
  },
  select: {
    startDate: true,
    endDate: true,
  },
});

  const fallbackNightlyRate = toMoney(property.baseNightlyRate);
 const minimumNightlyRate =
  property.minimumNightlyRate != null ? toMoney(property.minimumNightlyRate) : null;

const maximumNightlyRate =
  property.maximumNightlyRate != null ? toMoney(property.maximumNightlyRate) : null;

const dynamicPricingEnabled = Boolean(property.dynamicPricingEnabled);
const weekendMarkupPercent =
  property.weekendMarkupPercent != null
    ? toMoney(property.weekendMarkupPercent)
    : 0;

const occupancyPricingEnabled = Boolean(property.occupancyPricingEnabled);

const occupancyLookaheadDays =
  property.occupancyLookaheadDays != null
    ? Number(property.occupancyLookaheadDays)
    : 30;

const occupancyLowThresholdPercent =
  property.occupancyLowThresholdPercent != null
    ? toMoney(property.occupancyLowThresholdPercent)
    : null;

const occupancyLowAdjustmentPercent =
  property.occupancyLowAdjustmentPercent != null
    ? toMoney(property.occupancyLowAdjustmentPercent)
    : null;

const occupancyHighThresholdPercent =
  property.occupancyHighThresholdPercent != null
    ? toMoney(property.occupancyHighThresholdPercent)
    : null;

const occupancyHighAdjustmentPercent =
  property.occupancyHighAdjustmentPercent != null
    ? toMoney(property.occupancyHighAdjustmentPercent)
    : null;

const leadTimePricingEnabled = Boolean(property.leadTimePricingEnabled);

const leadTimeLastMinuteDays =
  property.leadTimeLastMinuteDays != null
    ? Number(property.leadTimeLastMinuteDays)
    : 3;

const leadTimeLastMinutePercent =
  property.leadTimeLastMinutePercent != null
    ? toMoney(property.leadTimeLastMinutePercent)
    : 0;

function isWeekendNight(date: Date) {
  const day = date.getUTCDay();
  return day === 5 || day === 6;
}

function applyWeekendRule(rate: number, date: Date) {
  if (!dynamicPricingEnabled) return rate;
  if (weekendMarkupPercent <= 0) return rate;
  if (!isWeekendNight(date)) return rate;

  return toMoney(rate * (1 + weekendMarkupPercent / 100));
}

function createWeekendDecision(
  rate: number,
  date: Date
): PricingDecisionStep | null {
  if (!dynamicPricingEnabled) return null;
  if (weekendMarkupPercent <= 0) return null;
  if (!isWeekendNight(date)) return null;

  const newRate = toMoney(rate * (1 + weekendMarkupPercent / 100));

  return createPricingDecisionStep({
    rule: "WEEKEND_RULE",
    label: "Weekend Boost",
    previousRate: rate,
    newRate,
    adjustmentPercent: weekendMarkupPercent,
  });
}

function getLeadTimeDays(date: Date) {
  const today = startOfUtcDay(new Date());
  const arrivalDate = startOfUtcDay(date);

  return Math.ceil(
    (arrivalDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );
}

function applyLeadTimeRule(rate: number, date: Date) {
  if (!dynamicPricingEnabled) return rate;
  if (!leadTimePricingEnabled) return rate;
  if (!Number.isFinite(leadTimeLastMinuteDays)) return rate;
  if (leadTimeLastMinuteDays <= 0) return rate;
  if (leadTimeLastMinutePercent === 0) return rate;

  const daysBeforeArrival = getLeadTimeDays(date);

  if (daysBeforeArrival < 0) return rate;
  if (daysBeforeArrival > leadTimeLastMinuteDays) return rate;

  return toMoney(rate * (1 + leadTimeLastMinutePercent / 100));
}

function createLeadTimeDecision(
  rate: number,
  date: Date
): PricingDecisionStep | null {
  if (!dynamicPricingEnabled) return null;
  if (!leadTimePricingEnabled) return null;
  if (!Number.isFinite(leadTimeLastMinuteDays)) return null;
  if (leadTimeLastMinuteDays <= 0) return null;
  if (leadTimeLastMinutePercent === 0) return null;

  const daysBeforeArrival = getLeadTimeDays(date);

  if (daysBeforeArrival < 0) return null;
  if (daysBeforeArrival > leadTimeLastMinuteDays) return null;

  const newRate = toMoney(rate * (1 + leadTimeLastMinutePercent / 100));

  return createPricingDecisionStep({
    rule: "LEAD_TIME_RULE",
    label: "Lead Time",
    previousRate: rate,
    newRate,
    adjustmentPercent: leadTimeLastMinutePercent,
  });
}

function getOccupancyPercent() {
  if (!Number.isFinite(occupancyLookaheadDays) || occupancyLookaheadDays <= 0) {
    return null;
  }

  const today = startOfUtcDay(new Date());
  const lookaheadEnd = addDays(today, occupancyLookaheadDays);

  const occupiedDates = new Set<string>();

  for (const reservation of occupancyReservations) {
    const start = startOfUtcDay(reservation.checkIn);
    const end = startOfUtcDay(reservation.checkOut);

    for (
      let cursor = start;
      cursor < end && cursor < lookaheadEnd;
      cursor = addDays(cursor, 1)
    ) {
      if (cursor >= today) {
        occupiedDates.add(toDateKey(cursor));
      }
    }
  }

  return toMoney((occupiedDates.size / occupancyLookaheadDays) * 100);
}

const occupancyPercent = getOccupancyPercent();

function isDateInSeason(date: Date, season: {
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
}) {
  const monthDay = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const startMonthDay = season.startMonth * 100 + season.startDay;
  const endMonthDay = season.endMonth * 100 + season.endDay;

  if (startMonthDay <= endMonthDay) {
    return monthDay >= startMonthDay && monthDay <= endMonthDay;
  }

  return monthDay >= startMonthDay || monthDay <= endMonthDay;
}

function getSeasonForDate(date: Date) {
  const matchingSeasons = property.seasons.filter((season) =>
    isDateInSeason(date, season)
  );

  if (matchingSeasons.length === 0) return null;

  return matchingSeasons.sort((a, b) => {
    return (
      Math.abs(Number(b.adjustmentPercent)) -
      Math.abs(Number(a.adjustmentPercent))
    );
  })[0];
}

function getHolidayForDate(date: Date) {
  const matchingHolidays = property.holidayPricings.filter((holiday) =>
    isDateInSeason(date, holiday)
  );

  if (matchingHolidays.length === 0) return null;

  return matchingHolidays.sort((a, b) => {
    return (
      Math.abs(Number(b.adjustmentPercent)) -
      Math.abs(Number(a.adjustmentPercent))
    );
  })[0];
}

function applySeasonalRule(rate: number, date: Date) {
  if (!dynamicPricingEnabled) return rate;
  if (!property.seasonalPricingEnabled) return rate;

  const season = getSeasonForDate(date);

  if (!season) return rate;

  return toMoney(rate * (1 + Number(season.adjustmentPercent) / 100));
}

function createSeasonalDecision(rate: number, date: Date): PricingDecisionStep | null {
  if (!dynamicPricingEnabled) return null;
  if (!property.seasonalPricingEnabled) return null;

  const season = getSeasonForDate(date);

  if (!season) return null;

  const percent = Number(season.adjustmentPercent);
  const newRate = toMoney(rate * (1 + percent / 100));

  return createPricingDecisionStep({
    rule: "SEASONAL_RULE",
    label: season.name || "Seasonal Pricing",
    previousRate: rate,
    newRate,
    adjustmentPercent: percent,
  });
}

function applyHolidayRule(rate: number, date: Date) {
  if (!dynamicPricingEnabled) return rate;
  if (!property.holidayPricingEnabled) return rate;

  const holiday = getHolidayForDate(date);

  if (!holiday) return rate;

  return toMoney(rate * (1 + Number(holiday.adjustmentPercent) / 100));
}

function createHolidayDecision(rate: number, date: Date): PricingDecisionStep | null {
  if (!dynamicPricingEnabled) return null;
  if (!property.holidayPricingEnabled) return null;

  const holiday = getHolidayForDate(date);

  if (!holiday) return null;

  const percent = Number(holiday.adjustmentPercent);
  const newRate = toMoney(rate * (1 + percent / 100));

  return createPricingDecisionStep({
    rule: "HOLIDAY_RULE",
    label: holiday.name || "Holiday Pricing",
    previousRate: rate,
    newRate,
    adjustmentPercent: percent,
  });
}

function applyOccupancyRule(rate: number) {
  if (!dynamicPricingEnabled) return rate;
  if (!occupancyPricingEnabled) return rate;
  if (occupancyPercent === null) return rate;

  if (
    occupancyLowThresholdPercent !== null &&
    occupancyLowAdjustmentPercent !== null &&
    occupancyPercent <= occupancyLowThresholdPercent
  ) {
    return toMoney(rate * (1 + occupancyLowAdjustmentPercent / 100));
  }

  if (
    occupancyHighThresholdPercent !== null &&
    occupancyHighAdjustmentPercent !== null &&
    occupancyPercent >= occupancyHighThresholdPercent
  ) {
    return toMoney(rate * (1 + occupancyHighAdjustmentPercent / 100));
  }

  return rate;
}

function createOccupancyDecision(rate: number): PricingDecisionStep | null {
  if (!dynamicPricingEnabled) return null;
  if (!occupancyPricingEnabled) return null;
  if (occupancyPercent === null) return null;

  if (
    occupancyLowThresholdPercent !== null &&
    occupancyLowAdjustmentPercent !== null &&
    occupancyPercent <= occupancyLowThresholdPercent
  ) {
    const newRate = toMoney(rate * (1 + occupancyLowAdjustmentPercent / 100));

    return createPricingDecisionStep({
      rule: "OCCUPANCY_LOW_RULE",
      label: "Low Occupancy",
      previousRate: rate,
      newRate,
      adjustmentPercent: occupancyLowAdjustmentPercent,
    });
  }

  if (
    occupancyHighThresholdPercent !== null &&
    occupancyHighAdjustmentPercent !== null &&
    occupancyPercent >= occupancyHighThresholdPercent
  ) {
    const newRate = toMoney(rate * (1 + occupancyHighAdjustmentPercent / 100));

    return createPricingDecisionStep({
      rule: "OCCUPANCY_HIGH_RULE",
      label: "High Occupancy",
      previousRate: rate,
      newRate,
      adjustmentPercent: occupancyHighAdjustmentPercent,
    });
  }

  return null;
}

function getPricingBoundsResult(rate: number): {
  rate: number;
  rule: "MINIMUM_NIGHTLY_RATE" | "MAXIMUM_NIGHTLY_RATE" | null;
  label: string | null;
} {
  let boundedRate = toMoney(rate);
  let rule: "MINIMUM_NIGHTLY_RATE" | "MAXIMUM_NIGHTLY_RATE" | null = null;
  let label: string | null = null;

  if (minimumNightlyRate !== null && boundedRate < minimumNightlyRate) {
    boundedRate = minimumNightlyRate;
    rule = "MINIMUM_NIGHTLY_RATE";
    label = "Minimum Nightly Rate";
  }

  if (maximumNightlyRate !== null && boundedRate > maximumNightlyRate) {
    boundedRate = maximumNightlyRate;
    rule = "MAXIMUM_NIGHTLY_RATE";
    label = "Maximum Nightly Rate";
  }

  return {
    rate: boundedRate,
    rule,
    label,
  };
}

function applyPricingBounds(rate: number) {
  return getPricingBoundsResult(rate).rate;
}

function createPricingBoundsDecision(rate: number): PricingDecisionStep | null {
  const boundsResult = getPricingBoundsResult(rate);

  if (!boundsResult.rule || boundsResult.rate === toMoney(rate)) {
    return null;
  }

  return createPricingDecisionStep({
    rule: boundsResult.rule,
    label: boundsResult.label ?? "Pricing Guardrail",
    previousRate: rate,
    newRate: boundsResult.rate,
    adjustmentPercent: null,
  });
}

function applyNightlyRateRounding(rate: number) {
  return Math.round(toMoney(rate));
}

function createNightlyRateRoundingDecision(
  rate: number
): DecisionStep<number> | null {
  const roundedRate = applyNightlyRateRounding(rate);

  if (roundedRate === toMoney(rate)) {
    return null;
  }

  return createPricingDecisionStep({
    rule: "NIGHTLY_RATE_ROUNDING",
    label: "Nightly Rate Rounding",
    previousRate: rate,
    newRate: roundedRate,
    adjustmentPercent: null,
  });
}

const stayDates = buildStayDates(input.checkIn, nights);

const nightlyRateByDate = new Map(
  property.nightlyRates.map((item) => [
    toDateKey(item.date),
    {
      rate: toMoney(item.rate),
      reason: item.reason ?? "CUSTOM_RATE",
    },
  ])
);

const nightlyRates = stayDates.map((date) => {
  const dateKey = toDateKey(date);
  const override = nightlyRateByDate.get(dateKey);
  const baseRateForDate = override?.rate ?? fallbackNightlyRate;

   const pricingBreakdown: PricingDecisionStep[] = [
    createPricingDecisionStep({
      rule: override ? "CUSTOM_RATE" : "BASE_RATE",
      label: override ? "Manual Override" : "Base Rate",
      previousRate: baseRateForDate,
      newRate: baseRateForDate,
      adjustmentPercent: null,
    }),
  ];

  let currentRate = baseRateForDate;

  if (!override) {
    const seasonalDecision = createSeasonalDecision(currentRate, date);

    if (seasonalDecision) {
      pricingBreakdown.push(seasonalDecision);
      currentRate = seasonalDecision.newValue;
    }

    const holidayDecision = createHolidayDecision(currentRate, date);

    if (holidayDecision) {
      pricingBreakdown.push(holidayDecision);
      currentRate = holidayDecision.newValue;
    }

    const occupancyDecision = createOccupancyDecision(currentRate);

    if (occupancyDecision) {
      pricingBreakdown.push(occupancyDecision);
      currentRate = occupancyDecision.newValue;
    }

    const leadTimeDecision = createLeadTimeDecision(currentRate, date);

    if (leadTimeDecision) {
      pricingBreakdown.push(leadTimeDecision);
      currentRate = leadTimeDecision.newValue;
    }

    const weekendDecision = createWeekendDecision(currentRate, date);

    if (weekendDecision) {
      pricingBreakdown.push(weekendDecision);
      currentRate = weekendDecision.newValue;
    }
  }

  const finalRateBeforeBounds = currentRate;

  const pricingBoundsDecision = createPricingBoundsDecision(finalRateBeforeBounds);

  if (pricingBoundsDecision) {
    pricingBreakdown.push(pricingBoundsDecision);
    currentRate = pricingBoundsDecision.newValue;
  } else {
    currentRate = applyPricingBounds(currentRate);
  }

  const boundedRate = currentRate;

  const roundingDecision = createNightlyRateRoundingDecision(boundedRate);

  if (roundingDecision) {
    pricingBreakdown.push(roundingDecision);
    currentRate = roundingDecision.newValue;
  } else {
    currentRate = applyNightlyRateRounding(currentRate);
  }

  const finalRate = currentRate;

  pricingBreakdown.push(
    createPricingDecisionStep({
      rule: "FINAL_RATE",
      label: "Final Rate",
      previousRate: baseRateForDate,
      newRate: finalRate,
      adjustmentPercent: null,
    })
  );
 
  const appliedRules = [
    ...(override ? [override.reason ?? "CUSTOM_RATE"] : []),
    ...pricingBreakdown
      .filter(
        (step) =>
          step.status === "APPLIED" &&
          step.rule !== "CUSTOM_RATE" &&
          step.rule !== "BASE_RATE" &&
          step.rule !== "FINAL_RATE" &&
          step.rule !== "NIGHTLY_RATE_ROUNDING"
      )
      .map((step) => step.rule),
  ];

  const normalizedAppliedRules =
    appliedRules.length > 0 ? Array.from(new Set(appliedRules)) : ["BASE_RATE"];

  return {
    date: dateKey,
    rate: finalRate,
    reason: normalizedAppliedRules[0],
    appliedRules: normalizedAppliedRules,
    pricingBreakdown,
  };
}); 

const nightlyRate = fallbackNightlyRate;
const cleaningFee = toMoney(property.cleaningFee);
const nightlySubtotal = toMoney(
  nightlyRates.reduce((sum, item) => sum + item.rate, 0)
);

const auditEntries = nightlyRates.map((item) =>
  createRevenueAuditEntry({
    entityId: input.propertyId,
    decisionId: `revenue-pricing:${input.propertyId}:${item.date}`,
    pricingBreakdown: item.pricingBreakdown,
    reason: item.reason,
    metadata: {
      propertyId: input.propertyId,
      date: item.date,
      rate: item.rate,
      appliedRules: item.appliedRules,
      currency: "usd",
    },
  })
);
const amenityItems = property.amenities.map((amenity) => {
    const baseAmount = toMoney(amenity.amount);

    const computedAmount =
      amenity.feeType === "PER_NIGHT"
        ? toMoney(baseAmount * nights)
        : baseAmount;

    const isSelected =
      amenity.chargeMode === "REQUIRED" ||
      (amenity.chargeMode === "OPTIONAL" && selectedAmenityIds.has(amenity.id));

    const amount = isSelected ? computedAmount : 0;

    return {
      id: amenity.id,
      name: amenity.name,
      description: amenity.description,
      chargeMode: amenity.chargeMode,
      feeType: amenity.feeType,
      amount,
      baseAmount,
      isSelected,
    };
  });

  const chargedAmenityItems = amenityItems.filter((item) => item.amount > 0);

  const amenitiesTotal = toMoney(
    chargedAmenityItems.reduce((sum, item) => sum + item.amount, 0)
  );

  const taxableSubtotal = toMoney(
    nightlySubtotal + cleaningFee + amenitiesTotal
  );

  const taxItems = property.taxes.map((tax) => {
    const percentage = toMoney(tax.percentage);
    const amount = toMoney(taxableSubtotal * (percentage / 100));

    return {
      id: tax.id,
      name: tax.name,
      percentage,
      amount,
    };
  });

  const taxesTotal = toMoney(
    taxItems.reduce((sum, item) => sum + item.amount, 0)
  );

  const totalAmount = toMoney(taxableSubtotal + taxesTotal);

return {
  currency: "usd",
  nights,
  nightlyRate,
  nightlyRates,
  nightlySubtotal,
  cleaningFee,
  amenities: amenityItems,
  chargedAmenities: chargedAmenityItems,
  amenitiesTotal,
  taxableSubtotal,
  taxes: taxItems,
  taxesTotal,
  totalAmount,
  totalAmountCents: Math.round(totalAmount * 100),
  auditEntries,
};
}

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function buildStayDates(checkIn: Date, nights: number) {
  return Array.from({ length: nights }, (_, index) =>
    startOfUtcDay(addDays(checkIn, index))
  );
}
