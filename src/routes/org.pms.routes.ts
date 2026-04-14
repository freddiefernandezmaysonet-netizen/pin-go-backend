import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { PmsConnectionStatus, PmsProvider } from "@prisma/client";
import { z } from "zod";
import crypto from "crypto";
import axios from "axios";
import { requireOrg } from "../middleware/requireOrg";

const GUESTY_AUTH_URL = "https://open-api.guesty.com/oauth2/token";
const HOSTAWAY_AUTH_URL = "https://api.hostaway.com/v1/accessTokens";
const LODGIFY_TEST_URL = "https://api.lodgify.com/v1/countries";

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

function decryptJson(payload: string) {
  const parsed = JSON.parse(payload ?? "{}");

  const key = crypto
    .createHash("sha256")
    .update(process.env.PMS_CREDENTIALS_SECRET ?? "")
    .digest();

  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(decrypted);
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

function validateProviderCredentials(
  data: z.infer<typeof connectionPayloadSchema>
) {
  if (data.provider === PmsProvider.GUESTY) {
    if (!data.clientId) {
      return "PMS_CLIENT_ID_REQUIRED";
    }
    if (!data.clientSecret) {
      return "PMS_CLIENT_SECRET_REQUIRED";
    }
  }

  if (data.provider === PmsProvider.HOSTAWAY) {
    if (!data.accountId) {
      return "PMS_ACCOUNT_ID_REQUIRED";
    }
    if (!data.apiKey) {
      return "PMS_API_KEY_REQUIRED";
    }
  }

  if (data.provider === PmsProvider.LODGIFY) {
    if (!data.apiKey) {
      return "PMS_API_KEY_REQUIRED";
    }
  }

  return null;
}

async function testGuestyConnection(input: {
  clientId: string;
  clientSecret: string;
}) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "open-api",
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });

  const resp = await axios.post(GUESTY_AUTH_URL, body.toString(), {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });

  const accessToken = resp.data?.access_token
    ? String(resp.data.access_token)
    : null;

  const expiresIn = Number(resp.data?.expires_in ?? 86400);

  if (!accessToken) {
    throw new Error("GUESTY_TOKEN_RESPONSE_INVALID");
  }

  return {
    accessToken,
    expiresIn,
  };
}

async function testHostawayConnection(input: {
  accountId: string;
  apiKey: string;
}) {
  const resp = await axios.post(
    HOSTAWAY_AUTH_URL,
    {
      grant_type: "client_credentials",
      client_id: input.accountId,
      client_secret: input.apiKey,
      scope: "general",
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  const accessToken =
    resp.data?.access_token ??
    resp.data?.token ??
    resp.data?.data?.access_token ??
    null;

  if (!accessToken) {
    throw new Error("HOSTAWAY_TOKEN_RESPONSE_INVALID");
  }

  return {
    accessToken: String(accessToken),
  };
}

async function testLodgifyConnection(input: {
  apiKey: string;
}) {
  const resp = await axios.get(LODGIFY_TEST_URL, {
    headers: {
      Accept: "application/json",
      "X-ApiKey": input.apiKey,
    },
    timeout: 15000,
  });

  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
  };
}

async function registerLodgifyWebhook(connection: any) {
  try {
    if (!connection.credentialsEncrypted) {
      console.warn("[lodgify] missing credentials");
      return;
    }

    const creds = decryptJson(connection.credentialsEncrypted);
    const apiKey = String(creds?.apiKey ?? "").trim();

    if (!apiKey) {
      console.warn("[lodgify] missing apiKey");
      return;
    }

    const baseUrl = process.env.PUBLIC_API_BASE_URL;

    if (!baseUrl) {
      console.warn("[lodgify] PUBLIC_API_BASE_URL missing");
      return;
    }

    const webhookUrl = `${String(baseUrl).replace(/\/+$/, "")}/webhooks/pms/lodgify/${connection.id}`;

    const payload = {
      event: "booking_change",
      url: webhookUrl,
    };

    console.log("[lodgify] subscribe payload", payload);

    const resp = await axios.post(
      "https://api.lodgify.com/webhooks/v1/subscribe",
      payload,
      {
        headers: {
          "X-ApiKey": apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; PinGo/1.0)",
        },
        timeout: 15000,
      }
    );

    console.log("[lodgify] webhook registered", {
      connectionId: connection.id,
      webhookUrl,
      status: resp.status,
      data: resp.data,
    });
  } catch (err: any) {
    console.error("[lodgify] webhook registration failed", {
      connectionId: connection?.id,
      status: err?.response?.status ?? null,
      error: err?.response?.data ?? err?.message,
    });
  }
}

export function buildOrgPmsRouter(prisma: PrismaClient) {
  const router = Router();

  router.use(requireOrg(prisma));

  router.get("/pms/connection", async (req, res) => {
    try {
      const orgId = String((req as any).orgId);
      const parsed = providerSchema.safeParse(
        String(req.query.provider ?? "").trim().toUpperCase()
      );

      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "INVALID_PROVIDER" });
      }

      const connection = await prisma.pmsConnection.findUnique({
        where: {
          organizationId_provider: {
            organizationId: orgId,
            provider: parsed.data,
          },
        },
      });

      return res.json({
        ok: true,
        connection: connection ? maskConnection(connection) : null,
      });
    } catch (e: any) {
      console.error("org/pms/connection GET error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "pms connection lookup failed",
      });
    }
  });

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

      const providerValidationError = validateProviderCredentials(data);
      if (providerValidationError) {
        return res.status(400).json({ ok: false, error: providerValidationError });
      }

      if (data.provider === PmsProvider.GUESTY) {
        try {
          const guesty = await testGuestyConnection({
            clientId: String(data.clientId),
            clientSecret: String(data.clientSecret),
          });

          return res.json({
            ok: true,
            message: `Connection to ${data.provider} verified successfully.`,
            checks: {
              provider: data.provider,
              hasAccountId: Boolean(data.accountId),
              hasClientId: Boolean(data.clientId),
              hasClientSecret: Boolean(data.clientSecret),
              hasApiKey: Boolean(data.apiKey),
              hasWebhookSecret: Boolean(data.webhookSecret),
              tokenIssued: true,
              tokenExpiresInSeconds: guesty.expiresIn,
            },
          });
        } catch (err: any) {
          console.error("Guesty test connection failed:", {
            message: err?.message,
            responseStatus: err?.response?.status,
            responseData: err?.response?.data,
          });

          return res.status(400).json({
            ok: false,
            error: "GUESTY_CONNECTION_TEST_FAILED",
            details: {
              message:
                err?.response?.data?.error_description ??
                err?.response?.data?.error ??
                err?.message ??
                "Guesty authentication failed",
              responseStatus: err?.response?.status ?? null,
            },
          });
        }
      }

      if (data.provider === PmsProvider.HOSTAWAY) {
        try {
          await testHostawayConnection({
            accountId: String(data.accountId),
            apiKey: String(data.apiKey),
          });

          return res.json({
            ok: true,
            message: `Connection to ${data.provider} verified successfully.`,
            checks: {
              provider: data.provider,
              hasAccountId: Boolean(data.accountId),
              hasClientId: Boolean(data.clientId),
              hasClientSecret: Boolean(data.clientSecret),
              hasApiKey: Boolean(data.apiKey),
              hasWebhookSecret: Boolean(data.webhookSecret),
              tokenIssued: true,
            },
          });
        } catch (err: any) {
          console.error("Hostaway test connection failed:", {
            message: err?.message,
            responseStatus: err?.response?.status,
            responseData: err?.response?.data,
          });

          return res.status(400).json({
            ok: false,
            error: "HOSTAWAY_CONNECTION_TEST_FAILED",
            details: {
              message:
                err?.response?.data?.message ??
                err?.response?.data?.error ??
                err?.message ??
                "Hostaway authentication failed",
              responseStatus: err?.response?.status ?? null,
            },
          });
        }
      }

      if (data.provider === PmsProvider.LODGIFY) {
        try {
          await testLodgifyConnection({
            apiKey: String(data.apiKey),
          });

          return res.json({
            ok: true,
            message: `Connection to ${data.provider} verified successfully.`,
            checks: {
              provider: data.provider,
              hasAccountId: Boolean(data.accountId),
              hasClientId: Boolean(data.clientId),
              hasClientSecret: Boolean(data.clientSecret),
              hasApiKey: Boolean(data.apiKey),
              hasWebhookSecret: Boolean(data.webhookSecret),
              tokenIssued: true,
            },
          });
        } catch (err: any) {
          console.error("Lodgify test connection failed:", {
            message: err?.message,
            responseStatus: err?.response?.status,
            responseData: err?.response?.data,
          });

          return res.status(400).json({
            ok: false,
            error: "LODGIFY_CONNECTION_TEST_FAILED",
            details: {
              message:
                err?.response?.data?.message ??
                err?.response?.data?.error ??
                err?.message ??
                "Lodgify authentication failed",
              responseStatus: err?.response?.status ?? null,
            },
          });
        }
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
      console.error("org/pms/test-connection error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "pms test connection failed",
      });
    }
  });

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

      const providerValidationError = validateProviderCredentials(data);
      if (providerValidationError) {
        return res.status(400).json({ ok: false, error: providerValidationError });
      }

      if (!process.env.PMS_CREDENTIALS_SECRET) {
        return res.status(500).json({
          ok: false,
          error: "PMS_CREDENTIALS_SECRET not configured",
        });
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
/*
    if (data.provider === PmsProvider.LODGIFY) {
  await registerLodgifyWebhook(connection);
}
*/
      return res.json({
        ok: true,
        message: `${data.provider} connection saved successfully.`,
        connection: maskConnection(connection),
      });
    } catch (e: any) {
      console.error("org/pms/connect error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "pms connect failed",
      });
    }
  });

  return router;
}