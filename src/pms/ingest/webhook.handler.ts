import { PrismaClient } from "@prisma/client";
import { normalizeReservationEvent } from "../normalizer/reservation.normalizer";

const prisma = new PrismaClient();

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function buildLocalDateFromDateOnly(value: string, time: string) {
  const [year, month, day] = value.trim().split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);

  return new Date(
    Date.UTC(
      year,
      (month ?? 1) - 1,
      day ?? 1,
      hours ?? 0,
      minutes ?? 0,
      0,
      0
    )
  );
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
      },
    });

    const propertyCheckInTime = property?.checkInTime ?? "15:00";
    const propertyCheckOutTime = "11:00";

    if (!normalized.checkIn) {
      throw new Error("NORMALIZED_RESERVATION_MISSING_CHECKIN");
    }

    if (!normalized.checkOut) {
      throw new Error("NORMALIZED_RESERVATION_MISSING_CHECKOUT");
    }

const checkIn =
  typeof normalized.checkIn === "string"
    ? isDateOnly(normalized.checkIn)
      ? buildLocalDateFromDateOnly(normalized.checkIn, propertyCheckInTime)
      : new Date(normalized.checkIn)
    : new Date(normalized.checkIn);

const checkOut =
  typeof normalized.checkOut === "string"
    ? isDateOnly(normalized.checkOut)
      ? buildLocalDateFromDateOnly(normalized.checkOut, propertyCheckOutTime)
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