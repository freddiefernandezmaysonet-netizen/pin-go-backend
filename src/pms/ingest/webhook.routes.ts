import { Router } from "express";
import { PrismaClient, PmsProvider } from "@prisma/client";
import { getAdapter } from "../adapters";
import type { ParseWebhookResult } from "../adapters/types";
import { enqueueProcessWebhookEvent } from "../jobs/job.queue";
import { verifyChannexWebhookSecret } from "./channex-webhook-auth";

const prisma = new PrismaClient();
export const pmsWebhookRouter = Router();

async function resolveChannexConnection(propertyId: string) {
  const activeConnections = await prisma.pmsConnection.findMany({
    where: {
      provider: PmsProvider.CHANNEX,
      status: "ACTIVE",
      listings: {
        some: {
          metadata: {
            path: ["channexPropertyId"],
            equals: propertyId,
          },
        },
      },
    },
    select: {
      id: true,
      webhookSecret: true,
    },
    take: 2,
  });

  if (activeConnections.length > 1) {
    throw new Error(`CHANNEX_PROPERTY_MAPPING_AMBIGUOUS:${propertyId}`);
  }

  return activeConnections[0] ?? null;
}

type IngestPmsWebhookDependencies = {
  findConnection: (connectionId: string) => Promise<{
    id: string;
    provider: PmsProvider;
    webhookSecret: string | null;
  } | null>;
  createEvent: (data: {
    connectionId: string;
    provider: PmsProvider;
    eventType: string;
    externalEventId: string | null;
    payloadRaw: any;
    status: "PENDING";
  }) => Promise<{ id: string }>;
  enqueueEvent: (eventId: string) => Promise<void>;
};

const defaultIngestPmsWebhookDependencies: IngestPmsWebhookDependencies = {
  findConnection: (connectionId) =>
    prisma.pmsConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        provider: true,
        webhookSecret: true,
      },
    }),
  createEvent: (data) =>
    prisma.webhookEventIngest.create({
      data,
      select: { id: true },
    }),
  enqueueEvent: enqueueProcessWebhookEvent,
};

export async function ingestPmsWebhook(
  args: {
    providerEnum: PmsProvider;
    connectionId: string;
    headers: any;
    body: any;
    rawBody?: Buffer;
    parsed?: ParseWebhookResult;
  },
  dependencies: IngestPmsWebhookDependencies =
    defaultIngestPmsWebhookDependencies
) {
  const conn = await dependencies.findConnection(args.connectionId);

  if (!conn) {
    return {
      status: 404,
      body: { ok: false, error: "CONNECTION_NOT_FOUND" },
    };
  }

  if (conn.provider !== args.providerEnum) {
    return {
      status: 400,
      body: { ok: false, error: "PROVIDER_MISMATCH" },
    };
  }

  const adapter = getAdapter(args.providerEnum);

  if (adapter.verifySignature && conn.webhookSecret) {
    const ok = adapter.verifySignature({
      secret: conn.webhookSecret,
      rawBody: args.rawBody ?? Buffer.from(""),
      headers: args.headers,
    });

    if (!ok) {
      return {
        status: 401,
        body: { ok: false, error: "INVALID_SIGNATURE" },
      };
    }
  }

  let parsed: ParseWebhookResult;

  try {
    parsed =
      args.parsed ??
      adapter.parseWebhook({
        headers: args.headers,
        body: args.body,
      });
  } catch (e: any) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "INVALID_PAYLOAD",
        detail: String(e?.message ?? e),
      },
    };
  }

  const externalEventId =
    parsed.externalEventId ?? parsed.bookingRevision?.revisionId ?? null;

  try {
    const ev = await dependencies.createEvent({
      connectionId: conn.id,
      provider: args.providerEnum,
      eventType: parsed.eventType ?? "UNKNOWN",
      externalEventId,
      payloadRaw: args.body,
      status: "PENDING",
    });

    if (args.providerEnum === PmsProvider.CHANNEX) {
      return {
        status: 200,
        body: { ok: true, eventId: ev.id },
      };
    }

    await dependencies.enqueueEvent(ev.id);

    return {
      status: 200,
      body: { ok: true, eventId: ev.id },
    };
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    if (
      msg.toLowerCase().includes("unique") ||
      msg.toLowerCase().includes("constraint")
    ) {
      return {
        status: 200,
        body: { ok: true, deduped: true },
      };
    }

    return {
      status: 500,
      body: {
        ok: false,
        error: "STORE_EVENT_FAILED",
        detail: msg,
      },
    };
  }
}

pmsWebhookRouter.post("/channex", async (req: any, res) => {
  try {
    const adapter = getAdapter(PmsProvider.CHANNEX);
    let parsed: ParseWebhookResult;

    try {
      parsed = adapter.parseWebhook({
        headers: req.headers,
        body: req.body,
      });
    } catch (error: any) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PAYLOAD",
        detail: String(error?.message ?? error),
      });
    }

    const propertyId = String(
      parsed.bookingRevision?.propertyId ?? ""
    ).trim();

    if (!propertyId) {
      return res.status(400).json({
        ok: false,
        error: "CHANNEX_PROPERTY_ID_REQUIRED",
      });
    }

    let connection: {
      id: string;
      webhookSecret: string | null;
    } | null;

    try {
      connection = await resolveChannexConnection(propertyId);
    } catch (error: any) {
      if (
        String(error?.message ?? error).startsWith(
          "CHANNEX_PROPERTY_MAPPING_AMBIGUOUS:"
        )
      ) {
        return res.status(409).json({
          ok: false,
          error: "CHANNEX_PROPERTY_MAPPING_AMBIGUOUS",
          propertyId,
        });
      }

      throw error;
    }

    if (!connection) {
      return res.status(404).json({
        ok: false,
        error: "CHANNEX_PROPERTY_MAPPING_NOT_FOUND",
        propertyId,
      });
    }

    if (
      !verifyChannexWebhookSecret({
        expectedSecret: connection.webhookSecret,
        headers: req.headers,
      })
    ) {
      return res.status(401).json({
        ok: false,
        error: "INVALID_WEBHOOK_AUTHENTICATION",
      });
    }

    const result = await ingestPmsWebhook({
      providerEnum: PmsProvider.CHANNEX,
      connectionId: connection.id,
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
      parsed,
    });

    return res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error("POST /webhooks/channex error", error);

    return res.status(500).json({
      ok: false,
      error: error?.message ?? "CHANNEX_WEBHOOK_FAILED",
    });
  }
});

/**
 * IMPORTANTE:
 * - Este router debe montarse con middleware que preserve rawBody.
 * - Usamos connectionId en la URL para resolver el tenant sin ambigüedad.
 * - Channex no puede usar esta ruta; su único ingreso permitido es /webhooks/channex.
 *
 * POST /webhooks/pms/:provider/:connectionId
 */
pmsWebhookRouter.post(
  "/pms/:provider/:connectionId",
  async (req: any, res) => {
    const provider = String(req.params.provider).toUpperCase();
    const connectionId = String(req.params.connectionId);

    const providerEnum = (PmsProvider as any)[provider] as
      | PmsProvider
      | undefined;
    if (!providerEnum) {
      return res.status(400).json({ ok: false, error: "UNKNOWN_PROVIDER" });
    }

    if (providerEnum === PmsProvider.CHANNEX) {
      return res.status(410).json({
        ok: false,
        error: "CHANNEX_LEGACY_WEBHOOK_ROUTE_DISABLED",
      });
    }

    const conn = await prisma.pmsConnection.findUnique({
      where: { id: connectionId },
    });
    if (!conn) {
      return res.status(404).json({ ok: false, error: "CONNECTION_NOT_FOUND" });
    }
    if (conn.provider !== providerEnum) {
      return res.status(400).json({ ok: false, error: "PROVIDER_MISMATCH" });
    }

    const adapter = getAdapter(providerEnum);
    if (adapter.verifySignature && conn.webhookSecret) {
      const ok = adapter.verifySignature({
        secret: conn.webhookSecret,
        rawBody: req.rawBody ?? Buffer.from(""),
        headers: req.headers,
      });
      if (!ok) {
        return res.status(401).json({ ok: false, error: "INVALID_SIGNATURE" });
      }
    }

    let parsed;
    try {
      parsed = adapter.parseWebhook({
        headers: req.headers,
        body: req.body,
      });
    } catch (e: any) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PAYLOAD",
        detail: String(e?.message ?? e),
      });
    }

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

      await enqueueProcessWebhookEvent(ev.id);

      return res.json({ ok: true });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        msg.toLowerCase().includes("unique") ||
        msg.toLowerCase().includes("constraint")
      ) {
        return res.json({ ok: true, deduped: true });
      }
      return res.status(500).json({
        ok: false,
        error: "STORE_EVENT_FAILED",
        detail: msg,
      });
    }
  }
);
