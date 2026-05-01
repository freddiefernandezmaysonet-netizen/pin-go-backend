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

      // 🔗 buscar conexión Lodgify real
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

      // 🧪 payload FAKE tipo Lodgify (clave)
      const now = new Date();
      const checkIn = new Date(now.getTime() + 2 * 60 * 1000);
      const checkOut = new Date(now.getTime() + 60 * 60 * 1000);

      const payload = {
        event: "booking_change",
        booking_id: `DEMO-${Date.now()}`,
        property_id: "DEMO_PROPERTY", // se mapeará por nombre luego
        property_name: "Demo", // IMPORTANTE → debe coincidir con tu property
        arrival: checkIn.toISOString().split("T")[0],
        departure: checkOut.toISOString().split("T")[0],
        guest_name: "Pin&Go Demo Guest",
        guest_email: "demo@pingo.com",
        status: "Booked",
        updated_at: new Date().toISOString(),
      };

      // 🧾 crear evento ingest
      const event = await prisma.webhookEventIngest.create({
        data: {
          connectionId: connection.id,
          provider: PmsProvider.LODGIFY,
          eventType: "DEMO_BOOKING",
          externalEventId: `DEMO-${Date.now()}`,
          payloadRaw: payload,
          status: "PENDING",
        },
      });

      // ⚙️ correr pipeline REAL
      await processWebhookEventById(event.id);

      return res.json({
        ok: true,
        data: {
          eventId: event.id,
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