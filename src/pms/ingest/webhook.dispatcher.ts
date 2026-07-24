import { PmsProvider } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { processChannexBookingWebhookEventById } from "./channex-booking-lifecycle.service";
import { processWebhookEventById } from "./webhook.processor";

export async function dispatchPmsWebhookEventById(eventId: string) {
  const event = await prisma.webhookEventIngest.findUnique({
    where: { id: eventId },
    select: {
      provider: true,
    },
  });

  if (!event) {
    return { found: false };
  }

  if (event.provider === PmsProvider.CHANNEX) {
    return processChannexBookingWebhookEventById(eventId);
  }

  await processWebhookEventById(eventId);

  return {
    found: true,
    processedBy: "LEGACY_PMS_PROCESSOR",
  };
}
