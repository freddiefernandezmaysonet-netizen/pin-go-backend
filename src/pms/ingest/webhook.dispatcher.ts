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
    try {
      return await processChannexBookingWebhookEventById(eventId);
    } catch (error: any) {
      const message = String(error?.message ?? error);

      if (message.startsWith("CHANNEX_FEED_NO_PENDING_REVISIONS:")) {
        await prisma.webhookEventIngest.update({
          where: { id: eventId },
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
            lastError: null,
          },
        });

        return {
          found: true,
          processed: true,
          revisionCount: 0,
          emptyFeed: true,
        };
      }

      throw error;
    }
  }

  await processWebhookEventById(eventId);

  return {
    found: true,
    processedBy: "LEGACY_PMS_PROCESSOR",
  };
}
