import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { requireOrg } from "../middleware/requireOrg";

function md5Lower32(input: string) {
  return crypto
    .createHash("md5")
    .update(input, "utf8")
    .digest("hex")
    .toLowerCase();
}

async function ttlockLoginWithPassword(username: string, password: string) {
  const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
  const client_id = process.env.TTLOCK_CLIENT_ID ?? "";
  const client_secret = process.env.TTLOCK_CLIENT_SECRET ?? "";

  const resp = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      grant_type: "password",
      username,
      password: md5Lower32(String(password ?? "")),
    }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(`TTLock HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }

  if (!data?.access_token || !data?.refresh_token) {
    throw new Error(`TTLock token missing fields: ${JSON.stringify(data)}`);
  }

  return data as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    uid?: number;
  };
}

export function buildOrgTtlockConnectV2Router(prisma: PrismaClient) {
  const router = Router();

  // 🔒 asegura multitenancy
  router.use(requireOrg(prisma));

  /**
   * POST /api/org/ttlock/connect
   */
  router.post("/ttlock/connect", async (req: any, res) => {
    try {
      console.log("🔵 TTLOCK CONNECT V2 HIT");
      console.log("BODY:", req.body);
      console.log("ORG ID:", req.orgId);

      const orgId = req.orgId;

      const username = String(req.body.username ?? "");
      const passwordPlain = String(req.body.password ?? "");

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          error: "ORGANIZATION_ID_REQUIRED",
        });
      }

      if (!username || !passwordPlain) {
        return res.status(400).json({
          ok: false,
          error: "Missing username or password",
        });
      }

      // Login contra TTLock
      const token = await ttlockLoginWithPassword(username, passwordPlain);

      await prisma.tTLockAuth.upsert({
        where: { organizationId: orgId },
        create: {
          organizationId: orgId,
          uid: token.uid,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: new Date(Date.now() + token.expires_in * 1000),
        },
        update: {
          uid: token.uid,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: new Date(Date.now() + token.expires_in * 1000),
        },
      });

      console.log("✅ TTLock conectado correctamente para org:", orgId);

      return res.json({
        ok: true,
        organizationId: orgId,
        connected: true,
      });

    } catch (e: any) {
      console.error("❌ org.ttlock.connect.v2 error:", e?.message ?? e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "TTLock connect failed",
      });
    }
  });

  return router;
}