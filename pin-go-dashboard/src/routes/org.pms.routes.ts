import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { PmsConnectionStatus, PmsProvider } from "@prisma/client";
import { z } from "zod";
import crypto from "crypto";
import { requireOrg } from "../middleware/requireOrg";

const providerSchema = z.nativeEnum(PmsProvider);

const connectionPayloadSchema = z.object({
  provider: providerSchema,
  accountName: z.string().trim().min(1).optional().nullable(),
  accountId: z.string().trim().min(1).optional().nullable(),
  clientId: z.string().trim().min(1).optional().nullable(),
  clientSecret: z.string().trim().min(1).optional().nullable(),
  apiKey: z.string().trim().min(1).optional().nullable(),
  webhookSecret: z.string().trim().min(1).optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

function getEncryptionKey() {
  const secret = process.env.PMS_CREDENTIALS_SECRET ?? "";
  if (!secret) {
    throw new Error("PMS_CREDENTIALS_SECRET not configured");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function encryptJson(value: unknown) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(value);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function maskConnection(connection: {
  id: string;
  organizationId: string;
  provider: PmsProvider;
  status: PmsConnectionStatus;
  credentialsEncrypted: string | null;
  webhookSecret: string | null;
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    provider: connection.provider,
    status: connection.status,
    hasCredentials: Boolean(connection.credentialsEncrypted),
    hasWebhookSecret: Boolean(connection.webhookSecret),
    metadata: connection.metadata ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export function buildOrgPmsRouter(prisma: PrismaClient) {
  const router = Router();

  router.use(requireOrg);

  /**
   * GET /api/org/pms/connection?provider=GUESTY
   */
  router.get("/pms/connection", async (req, res) => {
    try {
      const orgId = String((req as any).orgId);
      const parsed = providerSchema.safeParse(String(req.query.provider ?? "").trim().toUpperCase());

      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PROVIDER",
        });
      }

      const provider = parsed.data;

      const connection = await prisma.pmsConnection.findUnique({
        where: {
          organizationId_provider: {
            organizationId: orgId,
            provider,
          },
        },
      });

      return res.json({
        ok: true,
        connection: connection ? maskConnection(connection) : null,
      });
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "pms connection lookup failed",
      });
    }
  });

  /**
   * POST /api/org/pms/test-connection
   * Por ahora valida payload y readiness de configuración.
   * No llama aún a Guesty directamente.
   */
  router.post("/pms/test-connection", async (req, res) => {
    try {
      const parsed = connectionPayloadSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PAYLOAD",
          details: parsed.error.flatten(),
        });
      }

      const data = parsed.data;

      if (data.provider === PmsProvider.GUESTY) {
        if (!data.clientId) {
          return res.status(400).json({ ok: false, error: "PMS_CLIENT_ID_REQUIRED" });
        }
        if (!data.clientSecret) {
          return res.status(400).json({ ok: false, error: "PMS_CLIENT_SECRET_REQUIRED" });
        }
      }

      if (!process.env.PMS_CREDENTIALS_SECRET) {
        return res.status(500).json({
          ok: false,
          error: "PMS_CREDENTIALS_SECRET not configured",
        });
      }

      return res.json({
        ok: true,
        message: `Connection payload for ${data.provider} validated successfully.`,
        checks: {
          provider: data.provider,
          hasAccountId: Boolean(data.accountId),
          hasClientId: Boolean(data.clientId),
          hasClientSecret: Boolean(data.clientSecret),
          hasApiKey: Boolean(data.apiKey),
          hasWebhookSecret: Boolean(data.webhookSecret),
        },
      });
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "pms test connection failed",
      });
    }
  });

  /**
   * POST /api/org/pms/connect
   * Crea o actualiza PmsConnection por organization + provider.
   */
  router.post("/pms/connect", async (req, res) => {
    try {
      const orgId = String((req as any).orgId);
      const parsed = connectionPayloadSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PAYLOAD",
          details: parsed.error.flatten(),
        });
      }

      const data = parsed.data;

      if (data.provider === PmsProvider.GUESTY) {
        if (!data.clientId) {
          return res.status(400).json({ ok: false, error: "PMS_CLIENT_ID_REQUIRED" });
        }
        if (!data.clientSecret) {
          return res.status(400).json({ ok: false, error: "PMS_CLIENT_SECRET_REQUIRED" });
        }
      }

      const credentialsPayload = {
        accountId: data.accountId ?? null,
        clientId: data.clientId ?? null,
        clientSecret: data.clientSecret ?? null,
        apiKey: data.apiKey ?? null,
      };

      const credentialsEncrypted = encryptJson(credentialsPayload);

      const metadata = {
        accountName: data.accountName ?? null,
        notes: data.notes ?? null,
        connectedFrom: "dashboard",
        lastConfiguredAt: new Date().toISOString(),
      };

      const connection = await prisma.pmsConnection.upsert({
        where: {
          organizationId_provider: {
            organizationId: orgId,
            provider: data.provider,
          },
        },
        create: {
          organizationId: orgId,
          provider: data.provider,
          status: PmsConnectionStatus.ACTIVE,
          credentialsEncrypted,
          webhookSecret: data.webhookSecret ?? null,
          metadata,
        },
        update: {
          status: PmsConnectionStatus.ACTIVE,
          credentialsEncrypted,
          webhookSecret: data.webhookSecret ?? null,
          metadata,
        },
      });

      return res.json({
        ok: true,
        message: `${data.provider} connection saved successfully.`,
        connection: maskConnection(connection),
      });
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "pms connect failed",
      });
    }
  });

  return router;
}