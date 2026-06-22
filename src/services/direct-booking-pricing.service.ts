import { PrismaClient, ReservationStatus } from "@prisma/client";

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
  const year = date.getUTCFullYear();

  const seasonStart = new Date(
    Date.UTC(year, season.startMonth - 1, season.startDay)
  );

  let seasonEnd = new Date(
    Date.UTC(year, season.endMonth - 1, season.endDay)
  );

  if (seasonEnd < seasonStart) {
    seasonEnd = new Date(
      Date.UTC(year + 1, season.endMonth - 1, season.endDay)
    );
  }

  return date >= seasonStart && date <= seasonEnd;
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

function applySeasonalRule(rate: number, date: Date) {
  if (!dynamicPricingEnabled) return rate;
  if (!property.seasonalPricingEnabled) return rate;

  const season = getSeasonForDate(date);

  if (!season) return rate;

  return toMoney(rate * (1 + Number(season.adjustmentPercent) / 100));
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

function applyPricingBounds(rate: number) {
  let finalRate = rate;

  if (minimumNightlyRate !== null && finalRate < minimumNightlyRate) {
    finalRate = minimumNightlyRate;
  }

  if (maximumNightlyRate !== null && finalRate > maximumNightlyRate) {
    finalRate = maximumNightlyRate;
  }

  return finalRate;
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

  const appliedRules: string[] = [];

  if (override) {
    appliedRules.push(override.reason ?? "CUSTOM_RATE");
  } else {
    if (
      dynamicPricingEnabled &&
      occupancyPricingEnabled &&
      occupancyPercent !== null &&
      occupancyLowThresholdPercent !== null &&
      occupancyLowAdjustmentPercent !== null &&
      occupancyPercent <= occupancyLowThresholdPercent
    ) {
      appliedRules.push("OCCUPANCY_LOW_RULE");
    }

    if (
      dynamicPricingEnabled &&
      occupancyPricingEnabled &&
      occupancyPercent !== null &&
      occupancyHighThresholdPercent !== null &&
      occupancyHighAdjustmentPercent !== null &&
      occupancyPercent >= occupancyHighThresholdPercent
    ) {
      appliedRules.push("OCCUPANCY_HIGH_RULE");
    }

    if (
      dynamicPricingEnabled &&
      leadTimePricingEnabled &&
      leadTimeLastMinutePercent !== 0 &&
      getLeadTimeDays(date) >= 0 &&
      getLeadTimeDays(date) <= leadTimeLastMinuteDays
    ) {
      appliedRules.push("LEAD_TIME_RULE");
    }

    if (
      dynamicPricingEnabled &&
      weekendMarkupPercent > 0 &&
      isWeekendNight(date)
    ) {
      appliedRules.push("WEEKEND_RULE");
    }

    if (
  dynamicPricingEnabled &&
  property.seasonalPricingEnabled &&
  getSeasonForDate(date)
) {
  appliedRules.push("SEASONAL_RULE");
}

    if (appliedRules.length === 0) {
      appliedRules.push("BASE_RATE");
    }
  }

  const finalRateBeforeBounds = override
  ? baseRateForDate
  : applyWeekendRule(
      applyLeadTimeRule(
        applyOccupancyRule(
          applySeasonalRule(baseRateForDate, date)
        ),
        date
      ),
      date
    );
  
  const finalRate = applyPricingBounds(finalRateBeforeBounds);

  return {
    date: dateKey,
    rate: finalRate,
    reason: appliedRules[0],
    appliedRules,
  };
});

const nightlyRate = fallbackNightlyRate;
const cleaningFee = toMoney(property.cleaningFee);
const nightlySubtotal = toMoney(
  nightlyRates.reduce((sum, item) => sum + item.rate, 0)
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
