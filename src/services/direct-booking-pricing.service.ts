import { PrismaClient } from "@prisma/client";

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
  const weekendAdjustedRate = applyWeekendRule(baseRateForDate, date);

  return {
    date: dateKey,
    rate: applyPricingBounds(weekendAdjustedRate),
    reason:
      override?.reason ??
      (dynamicPricingEnabled && weekendMarkupPercent > 0 && isWeekendNight(date)
        ? "WEEKEND_RULE"
        : "BASE_RATE"),
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
