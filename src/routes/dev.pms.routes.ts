import { Router } from "express";
import { PrismaClient, PmsProvider } from "@prisma/client";
import { enqueueProcessWebhookEvent } from "../pms/jobs/job.queue";

const prisma = new PrismaClient();
export const devPmsRouter = Router();

/**
 * DEV: crear evento PMS manualmente
 *
 * POST /dev/pms/event
 */
devPmsRouter.post("/dev/pms/event", async (req, res) => {
  try {

    const {
      connectionId,
      externalReservationId,
      externalListingId,
      guestName,
      guestEmail,
      checkIn,
      checkOut,
    } = req.body;

    if (!connectionId) {
      return res.status(400).json({ ok: false, error: "MISSING_CONNECTION_ID" });
    }

    if (!externalReservationId) {
      return res.status(400).json({ ok: false, error: "MISSING_RESERVATION_ID" });
    }

    if (!externalListingId) {
      return res.status(400).json({ ok: false, error: "MISSING_LISTING_ID" });
    }

    const payload = {
      reservation: {
        provider: "GUESTY",
        externalReservationId,
        externalListingId,
        listingName: "DEV Listing",
        status: "CONFIRMED",
        checkIn,
        checkOut,
        guest: {
          name: guestName ?? "Dev Guest",
          email: guestEmail ?? "dev@test.com",
        },
      },
    };

    const ev = await prisma.webhookEventIngest.create({
      data: {
        connectionId,
        provider: PmsProvider.GUESTY,
        eventType: "DEV_RESERVATION",
        externalEventId: `DEV-${Date.now()}`,
        payloadRaw: payload,
        status: "PENDING",
      },
    });

    await enqueueProcessWebhookEvent(ev.id);

    return res.json({
      ok: true,
      eventId: ev.id,
      message: "DEV PMS event created",
    });

  } catch (e: any) {

    return res.status(500).json({
      ok: false,
      error: e?.message ?? "DEV_PMS_EVENT_FAILED",
    });
  }
});