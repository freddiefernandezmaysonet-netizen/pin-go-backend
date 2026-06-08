import type { PmsAdapter } from "./types";

function asString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const str = asString(value);
    if (str) return str;
  }

  return null;
}

export const channexAdapter: PmsAdapter = {
  provider: "CHANNEX",

  parseWebhook: ({ body }) => {
    const payload = body?.payload ?? body?.data ?? body;

    const eventType =
      firstString(
        body?.event,
        body?.eventType,
        body?.type,
        payload?.event,
        payload?.eventType,
        payload?.type
      ) ?? "BOOKING";

    const externalEventId = firstString(
      body?.id,
      body?.eventId,
      body?.event_id,
      payload?.id,
      payload?.eventId,
      payload?.event_id
    );

    const externalReservationId = firstString(
      body?.booking_id,
      body?.bookingId,
      body?.reservation_id,
      body?.reservationId,
      body?.unique_id,
      payload?.booking_id,
      payload?.bookingId,
      payload?.reservation_id,
      payload?.reservationId,
      payload?.unique_id,
      payload?.booking?.id,
      payload?.booking?.booking_id,
      payload?.booking?.unique_id,
      payload?.reservation?.id,
      payload?.reservation?.booking_id,
      payload?.reservation?.unique_id
    );

    return {
      eventType,
      externalEventId,
      externalReservationId: externalReservationId ?? undefined,
    };
  },
};