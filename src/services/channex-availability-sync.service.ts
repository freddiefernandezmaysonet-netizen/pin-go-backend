import { PrismaClient, PmsProvider } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_SYNC_DAYS = 365;

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
  };
}