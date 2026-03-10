import { PrismaClient } from "@prisma/client";
import { normalizeReservationEvent } from "../normalizer/reservation.normalizer";

const prisma = new PrismaClient();

/**
 * Procesa un webhook PMS ya recibido.
 */
export async function handlePmsWebhookEvent(params: {
  connectionId: string;
  provider: "GUESTY" | "CLOUDBEDS" | "HOSTAWAY";
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

        checkIn: new Date(normalized.checkIn),
        checkOut: new Date(normalized.checkOut),

        status: normalized.status === "CANCELLED"
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

        checkIn: new Date(normalized.checkIn),
        checkOut: new Date(normalized.checkOut),

        status: normalized.status === "CANCELLED"
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