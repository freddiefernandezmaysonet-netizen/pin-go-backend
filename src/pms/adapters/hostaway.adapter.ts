import type { PmsAdapter } from "./types";

export const hostawayAdapter: PmsAdapter = {
  provider: "HOSTAWAY",

  parseWebhook: ({ body }) => {
    const eventType =
      body?.event ??
      body?.eventType ??
      body?.type ??
      "RESERVATION";

    const externalEventId =
      body?.eventId ??
      body?.id ??
      body?.reservationId ??
      null;

    const externalReservationId =
      body?.reservationId ??
      body?.reservation_id ??
      body?.data?.reservationId ??
      body?.data?.reservation_id ??
      body?.reservation?.id ??
      body?.reservation?._id ??
      null;

    const externalListingId =
      body?.listingId ??
      body?.listing_id ??
      body?.propertyId ??
      body?.property_id ??
      body?.data?.listingId ??
      body?.data?.listing_id ??
      body?.data?.propertyId ??
      body?.data?.property_id ??
      body?.reservation?.listingId ??
      body?.reservation?.propertyId ??
      null;

    if (externalReservationId && externalListingId && body?.checkIn && body?.checkOut) {
      return {
        eventType,
        externalEventId,
        reservation: {
          provider: "HOSTAWAY",
          externalReservationId: String(externalReservationId),
          externalListingId: String(externalListingId),
          listingName:
            body?.listingName ??
            body?.propertyName ??
            body?.data?.listingName ??
            body?.data?.propertyName ??
            null,
          status:
            String(body?.status ?? "").toLowerCase() === "cancelled"
              ? "CANCELLED"
              : "CONFIRMED",
          checkIn: new Date(body.checkIn).toISOString(),
          checkOut: new Date(body.checkOut).toISOString(),
          guest: {
            name: body?.guestName ?? body?.guest?.name ?? null,
            email: body?.guestEmail ?? body?.guest?.email ?? null,
            phone: body?.guestPhone ?? body?.guest?.phone ?? null,
          },
          notes: body?.notes ?? null,
          raw: body,
        },
      };
    }

    return {
      eventType,
      externalEventId,
      externalReservationId: externalReservationId
        ? String(externalReservationId)
        : undefined,
    };
  },
};