import { PrismaClient } from "@prisma/client";
import { normalizeReservationEvent } from "../normalizer/reservation.normalizer";
import { fromZonedTime } from "date-fns-tz";

const prisma = new PrismaClient();

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function buildLocalDateFromDateOnly(
  value: string,
  time: string,
  timezone: string
) {
  const [hours, minutes] = time.split(":").map(Number);

  const localDateTime = `${value.trim()}T${String(hours ?? 0).padStart(2, "0")}:${String(
    minutes ?? 0
  ).padStart(2, "0")}:00`;

  return fromZonedTime(localDateTime, timezone);
}


/**
 * Procesa un webhook PMS ya recibido.
 */
export async function handlePmsWebhookEvent(params: {
  connectionId: string;
  provider: "GUESTY" | "CLOUDBEDS" | "HOSTAWAY" | "LODGIFY";
  eventType: string | null;
  payload: unknown;
}) {
  const { connectionId, provider, eventType, payload } = params;

  try {
    /**
     * 1. Normalizar el evento
     */
    const normalized = await normalizeReservationEvent({
      provider,
      eventType,
      payload,
    });

    /**
     * 2. Resolver listing PMS
     */
    const listing = await prisma.pmsListing.findFirst({
      where: {
        connectionId,
        externalListingId: normalized.externalListingId ?? undefined,
      },
    });

    if (!listing) {
      throw new Error("LISTING_NOT_FOUND");
    }

    if (!listing.propertyId) {
      throw new Error("LISTING_NOT_MAPPED");
    }

    /**
     * 2.1 Resolver hora local de la propiedad
     */
   
    const property = await prisma.property.findUnique({
  where: { id: listing.propertyId },
  select: {
    checkInTime: true,
    timezone: true,
  },
});

    const propertyCheckInTime = property?.checkInTime ?? "15:00";
    const propertyCheckOutTime = "11:00";
    const propertyTimeZone = property?.timezone ?? "America/Puerto_Rico";

    if (!normalized.checkIn) {
      throw new Error("NORMALIZED_RESERVATION_MISSING_CHECKIN");
    }

    if (!normalized.checkOut) {
      throw new Error("NORMALIZED_RESERVATION_MISSING_CHECKOUT");
    }

const checkIn =
  typeof normalized.checkIn === "string"
    ? isDateOnly(normalized.checkIn)
      ? buildLocalDateFromDateOnly(normalized.checkIn, propertyCheckInTime, propertyTimeZone)
      : new Date(normalized.checkIn)
    : new Date(normalized.checkIn);

const checkOut =
  typeof normalized.checkOut === "string"
    ? isDateOnly(normalized.checkOut)
      ? buildLocalDateFromDateOnly(normalized.checkOut, propertyCheckOutTime, propertyTimeZone)
      : new Date(normalized.checkOut)
    : new Date(normalized.checkOut);

   
    /**
     * 3. Upsert reservation interna
     */
    const reservation = await prisma.reservation.upsert({
      where: {
        externalProvider_externalId: {
          externalProvider: provider,
          externalId: normalized.externalReservationId,
        },
      },
      create: {
        propertyId: listing.propertyId,

        guestName: normalized.guestName,
        guestEmail: normalized.guestEmail,

        checkIn,
        checkOut,

        status:
          normalized.status === "CANCELLED"
            ? "CANCELLED"
            : "ACTIVE",

        externalProvider: provider,
        externalId: normalized.externalReservationId,
        source: "PMS",

        externalUpdatedAt: normalized.rawUpdatedAt
          ? new Date(normalized.rawUpdatedAt)
          : new Date(),
      },
      update: {
        guestName: normalized.guestName,
        guestEmail: normalized.guestEmail,

        checkIn,
        checkOut,

        status:
          normalized.status === "CANCELLED"
            ? "CANCELLED"
            : "ACTIVE",

        externalUpdatedAt: normalized.rawUpdatedAt
          ? new Date(normalized.rawUpdatedAt)
          : new Date(),
      },
    });

    return {
      ok: true,
      reservationId: reservation.id,
    };
  } catch (error: any) {
    console.error("PMS webhook handler error", error);

    return {
      ok: false,
      error: error?.message ?? "UNKNOWN_ERROR",
    };
  }
}