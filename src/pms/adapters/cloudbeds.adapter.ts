import type { PmsAdapter } from "./types";

export const cloudbedsAdapter: PmsAdapter = {
  provider: "CLOUDBEDS",
  parseWebhook: ({ body }) => {
    const eventType = body?.eventType ?? body?.event ?? "RESERVATION";
    const externalEventId = body?.eventId ?? body?.id ?? null;

    const externalReservationId =
      body?.reservationId ??
      body?.reservation_id ??
      body?.data?.reservationId ??
      body?.data?.reservation_id;

    const externalListingId =
      body?.roomTypeId ??
      body?.room_type_id ??
      body?.unitId ??
      body?.unit_id ??
      body?.data?.roomTypeId ??
      body?.data?.unitId;

    return {
      eventType,
      externalEventId,
      externalReservationId,
    };
  },
};