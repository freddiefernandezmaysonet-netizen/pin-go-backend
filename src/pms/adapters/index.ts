import { PmsProvider } from "@prisma/client";
import type { PmsAdapter } from "./types";

import { guestyAdapter } from "./guesty.adapter";
import { cloudbedsAdapter } from "./cloudbeds.adapter";
import { hostawayAdapter } from "./hostaway.adapter";

export function getAdapter(provider: PmsProvider): PmsAdapter {
  switch (provider) {
    case "GUESTY":
      return guestyAdapter;

    case "CLOUDBEDS":
      return cloudbedsAdapter;

    case "HOSTAWAY":
      return hostawayAdapter;

    default:
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