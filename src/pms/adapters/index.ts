import { PmsProvider } from "@prisma/client";
import type { PmsAdapter } from "./types";

// TODO: implement real adapters next
import { guestyAdapter } from "./guesty.adapter";
import { cloudbedsAdapter } from "./cloudbeds.adapter";

export function getAdapter(provider: PmsProvider): PmsAdapter {
  switch (provider) {
    case "GUESTY":
      return guestyAdapter;
    case "CLOUDBEDS":
      return cloudbedsAdapter;
    default:
      // fallback minimal
      return {
        provider: String(provider),
        parseWebhook: ({ body }) => ({
          eventType: body?.eventType ?? "UNKNOWN",
          externalEventId: body?.id ?? null,
          externalReservationId: body?.reservationId ?? body?.reservation_id,
        }),
      };
  }
}