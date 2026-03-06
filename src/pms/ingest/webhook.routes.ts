import { Router } from "express";
import { PrismaClient, PmsProvider } from "@prisma/client";
import { getAdapter } from "../adapters";
import { readRawBodyMiddleware } from "./webhook.verify";
import { enqueueProcessWebhookEvent } from "../jobs/job.queue";

const prisma = new PrismaClient();
export const pmsWebhookRouter = Router();

/**
 * IMPORTANTE:
 * - Este router debe montarse con middleware que preserve rawBody.
 * - Usamos connectionId en la URL para resolver el tenant sin ambigüedad.
 *
 * POST /webhooks/pms/:provider/:connectionId
 */
pmsWebhookRouter.post(
  "/pms/:provider/:connectionId",
  readRawBodyMiddleware, // nos deja req.rawBody (Buffer)
  async (req: any, res) => {
    const provider = String(req.params.provider).toUpperCase();
    const connectionId = String(req.params.connectionId);

    // 1) Validar provider enum
    const providerEnum = (PmsProvider as any)[provider] as PmsProvider | undefined;
    if (!providerEnum) return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });

    // 2) Buscar conexión
    const conn = await prisma.pmsConnection.findUnique({ where: { id: connectionId } });
    if (!conn) return res.status(404).json({ ok: false, error: "CONNECTION_NOT_FOUND" });
    if (conn.provider !== providerEnum) return res.status(400).json({ ok: false, error: "PROVIDER_MISMATCH" });

    // 3) Signature verify (si aplica)
    const adapter = getAdapter(providerEnum);
    if (adapter.verifySignature && conn.webhookSecret) {
      const ok = adapter.verifySignature({
        secret: conn.webhookSecret,
        rawBody: req.rawBody ?? Buffer.from(""),
        headers: req.headers,
      });
      if (!ok) return res.status(401).json({ ok: false, error: "INVALID_SIGNATURE" });
    }

    // 4) Parse para sacar eventType/externalEventId si existe
    let parsed;
    try {
      parsed = adapter.parseWebhook({ headers: req.headers, body: req.body });
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD", detail: String(e?.message ?? e) });
    }

    // 5) Guardar evento crudo (event store)
    // Nota: externalEventId es unique con connectionId; si viene duplicado, Prisma lanzará error y lo tratamos como OK (idempotente)
    try {
      const ev = await prisma.webhookEventIngest.create({
        data: {
          connectionId: conn.id,
          provider: providerEnum,
          eventType: parsed.eventType ?? "UNKNOWN",
          externalEventId: parsed.externalEventId ?? null,
          payloadRaw: req.body,
          status: "PENDING",
        },
      });

      // 6) Enqueue async
      await enqueueProcessWebhookEvent(ev.id);

      return res.json({ ok: true });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Dedupe por unique (connectionId, externalEventId)
      if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("constraint")) {
        return res.json({ ok: true, deduped: true });
      }
      return res.status(500).json({ ok: false, error: "STORE_EVENT_FAILED", detail: msg });
    }
  }
);