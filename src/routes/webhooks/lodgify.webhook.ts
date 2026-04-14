import { Router } from "express";
import { PrismaClient } from "@prisma/client";

// Ajusta estos imports a tus paths reales:
import { getAdapter } from "../../pms/adapters";
import { processWebhookEventById } from "../../services/pms/processWebhookEventById";

const prisma = new PrismaClient();
const router = Router();

/**
 * POST /webhooks/pms/lodgify/:connectionId
 *
 * Diseño:
 * - Resuelve tenant/provider desde PmsConnection
 * - No rompe adapters existentes
 * - Persiste primero el webhook en ingest
 * - Luego dispara el pipeline actual
 * - Responde 200 rápido
 */
router.post("/webhooks/pms/lodgify/:connectionId", async (req, res) => {
  const connectionId = String(req.params.connectionId ?? "").trim();

  if (!connectionId) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_CONNECTION_ID",
    });
  }

  try {
    const connection = await prisma.pmsConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        orgId: true,
        provider: true,
        status: true,
      },
    });

    if (!connection) {
      return res.status(404).json({
        ok: false,
        error: "PMS_CONNECTION_NOT_FOUND",
      });
    }

    if (String(connection.provider).toUpperCase() !== "LODGIFY") {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PROVIDER_FOR_ENDPOINT",
      });
    }

    const adapter = getAdapter(connection.provider);

    /**
     * Idealmente el adapter Lodgify debe exponer un normalizer liviano para webhook.
     * Si ya tienes una convención similar en otros providers, reutilízala.
     *
     * Resultado esperado:
     * - eventType: string
     * - externalEventId?: string
     * - externalObjectId?: string
     * - occurredAt?: Date | string | null
     * - payload: object
     */
    const normalized = adapter.parseWebhook
      ? await adapter.parseWebhook({
          headers: req.headers,
          body: req.body,
          params: req.params,
          connection,
        })
      : {
          eventType: "lodgify.webhook.received",
          externalEventId: null,
          externalObjectId: null,
          occurredAt: new Date(),
          payload: req.body ?? {},
        };

    /**
     * Persistimos primero el evento de webhook en el pipeline actual.
     * Ajusta los nombres de campos a tu modelo real de ingest.
     */
    const ingest = await prisma.webhookEventIngest.create({
      data: {
        provider: connection.provider,
        orgId: connection.orgId,
        pmsConnectionId: connection.id,

        eventType: String(normalized.eventType ?? "lodgify.webhook.received"),
        externalEventId: normalized.externalEventId
          ? String(normalized.externalEventId)
          : null,
        externalObjectId: normalized.externalObjectId
          ? String(normalized.externalObjectId)
          : null,

        payload: normalized.payload ?? req.body ?? {},
        status: "RECEIVED",
        receivedAt: new Date(),
        occurredAt: normalized.occurredAt ? new Date(normalized.occurredAt) : null,
      },
    });

    // Dispara el pipeline actual sin rediseñarlo
    await processWebhookEventById(ingest.id);

    return res.status(200).json({
      ok: true,
      accepted: true,
      provider: connection.provider,
      connectionId: connection.id,
      ingestId: ingest.id,
    });
  } catch (error: any) {
    console.error("[lodgify webhook] failed", {
      connectionId,
      error: error?.message ?? String(error),
    });

    return res.status(500).json({
      ok: false,
      error: "LODGiFY_WEBHOOK_FAILED",
    });
  }
});

export default router;