import { PrismaClient, PmsProvider } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();

const DEFAULT_SYNC_DAYS = 365;
const CHANNEX_API_BASE_URL =
  process.env.CHANNEX_API_BASE_URL ?? "https://staging.channex.io";

function getChannexApiKey() {
  const apiKey = String(process.env.CHANNEX_API_KEY ?? "").trim();

  if (!apiKey) {
    throw new Error("CHANNEX_API_KEY_MISSING");
  }

  return apiKey;
}

type ChannexListingMetadata = {
  channexPropertyId?: string;
  channexRatePlanId?: string;
  provisionedAt?: string;
};

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseMetadata(value: unknown): ChannexListingMetadata {
  if (!value || typeof value !== "object") return {};
  return value as ChannexListingMetadata;
}

export async function syncChannexAvailabilityForProperty(
  propertyId: string,
  days = DEFAULT_SYNC_DAYS
) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
   select: {
  id: true,
  organizationId: true,
  name: true,
  publicTitle: true,
  maxGuests: true,
  minimumNights: true,
  baseNightlyRate: true,
  minimumNightlyRate: true,
  maximumNightlyRate: true,
},
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const connection = await prisma.pmsConnection.findUnique({
    where: {
      organizationId_provider: {
        organizationId: property.organizationId,
        provider: PmsProvider.CHANNEX,
      },
    },
  });

  if (!connection) {
    return {
      ok: true,
      skipped: true,
      reason: "CHANNEX_CONNECTION_NOT_FOUND",
      propertyId: property.id,
    };
  }

  const listing = await prisma.pmsListing.findFirst({
    where: {
      connectionId: connection.id,
      propertyId: property.id,
    },
  });

  if (!listing) {
    return {
      ok: true,
      skipped: true,
      reason: "CHANNEX_LISTING_NOT_FOUND",
      propertyId: property.id,
    };
  }

  const metadata = parseMetadata(listing.metadata);

  const channexPropertyId = metadata.channexPropertyId;
  const channexRoomTypeId = listing.externalListingId;
  const channexRatePlanId = metadata.channexRatePlanId;
  
 if (!channexPropertyId || !channexRoomTypeId || !channexRatePlanId) {
    throw new Error("CHANNEX_LISTING_MAPPING_INCOMPLETE");
  }

const apiKey = getChannexApiKey();
 
  let roomTypeResp;

  try {
    roomTypeResp = await axios.put(
      `${CHANNEX_API_BASE_URL.replace(/\/+$/, "")}/api/v1/room_types/${channexRoomTypeId}`,
      {
        room_type: {
          title: property.publicTitle ?? property.name,
          count_of_rooms: 1,
          occ_adults: property.maxGuests ?? 2,
          occ_children: 0,
          occ_infants: 0,
          default_occupancy: property.maxGuests ?? 2,
        },
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-api-key": apiKey,
        },
        timeout: 20000,
      }
    );
  } catch (err: any) {
    console.error("[channex][room_type_sync][failed]", {
      status: err?.response?.status ?? null,
      data: err?.response?.data ?? null,
      roomTypeId: channexRoomTypeId,
      message: err?.message,
    });

    throw new Error(
      `CHANNEX_ROOM_TYPE_SYNC_FAILED: ${JSON.stringify(
        err?.response?.data ?? err?.message
      )}`
    );
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const from = today;
  const to = addDays(today, days);

  const reservations = await prisma.reservation.findMany({
    where: {
      propertyId: property.id,
      status: "ACTIVE",
      checkIn: { lt: to },
      checkOut: { gt: from },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
    },
  });

  const blockedDates = await prisma.propertyBlockedDate.findMany({
    where: {
      propertyId: property.id,
      startDate: { lt: to },
      endDate: { gt: from },
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
    },
  });

const nightlyRates = await prisma.propertyNightlyRate.findMany({
  where: {
    propertyId: property.id,
    date: {
      gte: from,
      lt: to,
    },
  },
  select: {
    date: true,
    rate: true,
  },
});

const nightlyRateByDate = new Map(
  nightlyRates.map((item) => [
    toDateKey(item.date),
    Number(item.rate),
  ])
);

  const unavailableDateKeys = new Set<string>();

  for (const reservation of reservations) {
    const cursor = new Date(reservation.checkIn);
    cursor.setUTCHours(0, 0, 0, 0);

    const end = new Date(reservation.checkOut);
    end.setUTCHours(0, 0, 0, 0);

    while (cursor < end) {
      unavailableDateKeys.add(toDateKey(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  for (const blockedDate of blockedDates) {
    const cursor = new Date(blockedDate.startDate);
    cursor.setUTCHours(0, 0, 0, 0);

    const end = new Date(blockedDate.endDate);
    end.setUTCHours(0, 0, 0, 0);

    while (cursor < end) {
      unavailableDateKeys.add(toDateKey(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const availabilityPreview = Array.from({ length: days }, (_, index) => {
    const date = addDays(from, index);
    const dateKey = toDateKey(date);

    return {
      date: dateKey,
      availability: unavailableDateKeys.has(dateKey) ? 0 : 1,
    };
  });

  const minimumNightlyRate =
  property.minimumNightlyRate != null
    ? Number(property.minimumNightlyRate)
    : null;

const maximumNightlyRate =
  property.maximumNightlyRate != null
    ? Number(property.maximumNightlyRate)
    : null;

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

  const ratesPayload = availabilityPreview.map((item) => ({
    property_id: channexPropertyId,
    rate_plan_id: channexRatePlanId,
    date: item.date,

    availability: item.availability,
    available: item.availability === 1,

   rate: Math.max(
  Math.round(
    applyPricingBounds(
      Number(
        nightlyRateByDate.get(item.date) ??
          property.baseNightlyRate ??
          0
      )
    ) * 100
  ),
  1000
),
    min_stay_arrival: property.minimumNights ?? 1,
    min_stay_through: property.minimumNights ?? 1,

 }));

  let ratesResp;

  try {
    ratesResp = await axios.post(
      `${CHANNEX_API_BASE_URL.replace(/\/+$/, "")}/api/v1/restrictions`,
      {
        values: ratesPayload,
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-api-key": apiKey,
        },
        timeout: 20000,
      }
    );
  } catch (err: any) {
    console.error("[channex][rates_sync][failed]", {
      status: err?.response?.status ?? null,
      data: err?.response?.data ?? null,
      payloadPreview: ratesPayload.slice(0, 5),
      message: err?.message,
    });

    throw new Error(
      `CHANNEX_RATES_SYNC_FAILED: ${JSON.stringify(
        err?.response?.data ?? err?.message
      )}`
    );
  }

  const channexAvailabilityPayload = availabilityPreview.map((item) => ({
    property_id: channexPropertyId,
    room_type_id: channexRoomTypeId,
    date: item.date,
    availability: item.availability,
  }));

  let availabilityResp;

  try {
    availabilityResp = await axios.post(
      `${CHANNEX_API_BASE_URL.replace(/\/+$/, "")}/api/v1/availability`,
      {
        values: channexAvailabilityPayload,
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-api-key": apiKey,
        },
        timeout: 20000,
      }
    );
  } catch (err: any) {
    console.error("[channex][availability_sync][failed]", {
      status: err?.response?.status ?? null,
      data: err?.response?.data ?? null,
      payloadPreview: channexAvailabilityPayload.slice(0, 5),
      message: err?.message,
    });

    throw new Error(
      `CHANNEX_AVAILABILITY_SYNC_FAILED: ${JSON.stringify(
        err?.response?.data ?? err?.message
      )}`
    );
  }

  return {
    ok: true,
    propertyId: property.id,
    channexPropertyId,
    channexRoomTypeId,
    channexRatePlanId,
    from: toDateKey(from),
    to: toDateKey(to),
    reservationsCount: reservations.length,
    blockedDatesCount: blockedDates.length,
    unavailableDaysCount: unavailableDateKeys.size,
    previewCount: availabilityPreview.length,
    preview: availabilityPreview.slice(0, 14),

    roomTypeChannexResponse: roomTypeResp.data,
    roomTypeChannexStatus: roomTypeResp.status,
    ratesPayloadPreview: ratesPayload.slice(0, 5),
    ratesChannexResponse: ratesResp.data,
    ratesChannexStatus: ratesResp.status,

    availabilityPayloadPreview: channexAvailabilityPayload.slice(0, 5),
    availabilityChannexResponse: availabilityResp.data,
    availabilityChannexStatus: availabilityResp.status,

    pushedToChannex: true,
  };
}
