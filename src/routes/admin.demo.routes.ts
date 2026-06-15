import { Router } from "express";
import { PrismaClient, PmsProvider } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { processWebhookEventById } from "../pms/ingest/webhook.processor";

const prisma = new PrismaClient();
export const adminDemoRouter = Router();

function assertPlatformAdmin(req: any, res: any) {
  const user = req.user;

  if (!user || user.role !== "PLATFORM_ADMIN") {
    res.status(403).json({
      ok: false,
      error: "Forbidden",
    });
    return false;
  }

  return true;
}

adminDemoRouter.post(
  "/api/internal/admin/demo/run",
  requireAuth,
  async (req, res) => {
    try {
      if (!assertPlatformAdmin(req, res)) return;

      const user = req.user;
      const orgId = user.orgId as string;

      const { checkIn, checkOut } = req.body ?? {};

      if (!checkIn || !checkOut) {
        return res.status(400).json({
          ok: false,
          error: "Missing checkIn/checkOut",
        });
      }

      const checkInDate = new Date(checkIn);
      const checkOutDate = new Date(checkOut);

      if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
        return res.status(400).json({
          ok: false,
          error: "Invalid checkIn/checkOut",
        });
      }

      if (checkOutDate <= checkInDate) {
        return res.status(400).json({
          ok: false,
          error: "checkOut must be after checkIn",
        });
      }

      const connection = await prisma.pmsConnection.findFirst({
        where: {
          organizationId: orgId,
          provider: PmsProvider.LODGIFY,
          status: "ACTIVE",
        },
      });

      if (!connection) {
        return res.status(400).json({
          ok: false,
          error: "No active Lodgify connection found",
        });
      }

      const externalId = `DEMO-${Date.now()}`;

      const payload = {
        event: "booking_change",
        booking_id: externalId,
        id: externalId,

        property_id: "DEMO",
        property_name: "Demo",

        arrival: checkInDate.toISOString(),
        departure: checkOutDate.toISOString(),

        guest_name: "Pin&Go Demo Guest",
        guest_email: "demo@pingo.com",
        guest_phone: "+17876768198",

        status: "Booked",

        amount_paid: 100,
        total_amount: 100,
        amount_due: 0,

        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),

        demo: true,
        created_by: user.email ?? user.id,
      };

      const event = await prisma.webhookEventIngest.create({
        data: {
          connectionId: connection.id,
          provider: PmsProvider.LODGIFY,
          eventType: "DEMO_BOOKING",
          externalEventId: externalId,
          payloadRaw: payload,
          status: "PENDING",
        },
      });

      await processWebhookEventById(event.id);

      const processedEvent = await prisma.webhookEventIngest.findUnique({
        where: { id: event.id },
      });

      const reservation = await prisma.reservation.findFirst({
        where: {
          externalProvider: "LODGIFY",
          externalId,
        },
        include: {
          accessGrants: {
            include: {
              lock: true,
            },
          },
          NfcAssignment: true,
        },
      });

      return res.json({
        ok: true,
        data: {
          eventId: event.id,
          eventStatus: processedEvent?.status ?? null,
          eventError: processedEvent?.lastError ?? null,
          reservation,
          checkIn: checkInDate.toISOString(),
          checkOut: checkOutDate.toISOString(),
          paymentState: "PAID",
          message: "Demo pipeline executed",
        },
      });
    } catch (error) {
      console.error("[DEMO_PIPELINE_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: "Demo pipeline failed",
      });
    }
  }
);

adminDemoRouter.post(
  "/api/internal/webhook-events/:id/reprocess"
  async (req, res) => {
    try {
      const { id } = req.params;

      const existing = await prisma.webhookEventIngest.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "WEBHOOK_EVENT_NOT_FOUND",
        });
      }

      await prisma.webhookEventIngest.update({
        where: { id },
        data: {
          status: "PENDING",
          lastError: null,
          processedAt: null,
        },
      });

      await processWebhookEventById(id);

      const processed = await prisma.webhookEventIngest.findUnique({
        where: { id },
      });

      return res.json({
        ok: true,
        eventId: id,
        status: processed?.status ?? null,
        lastError: processed?.lastError ?? null,
        processedAt: processed?.processedAt ?? null,
      });
    } catch (error: any) {
      console.error("[WEBHOOK_REPROCESS_ERROR]", error);

      return res.status(500).json({
        ok: false,
        error: error?.message ?? "WEBHOOK_REPROCESS_FAILED",
      });
    }
  }
);