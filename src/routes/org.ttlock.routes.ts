import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { ttlockListLocksWithAccessToken } from "../ttlock/ttlock.api";

export function buildOrgTtlockRouter(prisma: PrismaClient) {
  const router = Router();

  async function ttlockRefreshAccessToken(refreshToken: string) {
    const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
    const client_id = process.env.TTLOCK_CLIENT_ID ?? "";
    const client_secret = process.env.TTLOCK_CLIENT_SECRET ?? "";

    if (!client_id || !client_secret) {
      throw new Error("TTLOCK_CLIENT_ID/TTLOCK_CLIENT_SECRET not configured");
    }

    const resp = await fetch(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        client_secret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        date: String(Date.now()),
      }),
    });

    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`TTLock refresh returned non-JSON. First 120 chars: ${text.slice(0, 120)}`);
    }

    if (!resp.ok) {
      throw new Error(`TTLock refresh HTTP ${resp.status}: ${JSON.stringify(data)}`);
    }
    if (data?.errcode) {
      throw new Error(`TTLock refresh errcode=${data.errcode} errmsg=${data.errmsg ?? "unknown"}`);
    }
    if (!data?.access_token) {
      throw new Error(`TTLock refresh missing access_token: ${JSON.stringify(data)}`);
    }

    return data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      uid?: number;
    };
  }

  /**
   * GET /api/org/ttlock/locks?organizationId=...
   * Devuelve lista de locks desde TTLock para esa org.
   */
  router.get("/ttlock/locks", async (req, res) => {
    try {
      const organizationId = String(req.query.organizationId ?? "").trim();
      if (!organizationId) {
        return res.status(400).json({ ok: false, error: "organizationId required" });
      }

      const auth = await prisma.tTLockAuth.findUnique({
        where: { organizationId },
        select: { accessToken: true, refreshToken: true, expiresAt: true, uid: true },
      });

      if (!auth?.refreshToken) {
        return res.status(401).json({ ok: false, error: "TTLOCK_NOT_CONNECTED" });
      }

      // refresh si no hay accessToken o si expira en < 2 min
      const now = Date.now();
      const expiresAtMs = auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0;
      const shouldRefresh = !auth.accessToken || !auth.expiresAt || expiresAtMs - now < 2 * 60 * 1000;

      let accessToken = auth.accessToken ?? "";

      if (shouldRefresh) {
        const refreshed = await ttlockRefreshAccessToken(auth.refreshToken);

        const newAccess = refreshed.access_token;
        const newRefresh = refreshed.refresh_token ?? auth.refreshToken;
        const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

        await prisma.tTLockAuth.update({
          where: { organizationId },
          data: {
            accessToken: newAccess,
            refreshToken: newRefresh,
            expiresAt: newExpiresAt,
            uid: refreshed.uid ?? auth.uid ?? undefined,
          },
        });

        accessToken = newAccess;
      }

      if (!accessToken) {
        return res.status(409).json({ ok: false, error: "TTLOCK_NOT_CONNECTED" });
      }

      // ✅ listar locks usando el token de ESA org
      const resp = await ttlockListLocksWithAccessToken(accessToken, 1, 100);

      const locks = (resp?.list ?? []).map((l: any) => ({
        ttlockLockId: Number(l.lockId),
        name: String(l.lockName ?? l.lockAlias ?? ""),
      }));

      return res.json({ ok: true, organizationId, locks });
    } catch (e: any) {
      console.error("org/ttlock/locks error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "list locks failed" });
    }
  });

  /**
   * POST /api/org/ttlock/sync-locks
   * Body: { organizationId, propertyId }
   * - Verifica que propertyId pertenezca a la org
   * - Lista locks desde TTLock (refresh token si hace falta)
   * - Upsert en Prisma.Lock por ttlockLockId asignando propertyId
   */
  router.post("/ttlock/sync-locks", async (req, res) => {
    try {
      const organizationId = String(req.body?.organizationId ?? "").trim();
      const propertyId = String(req.body?.propertyId ?? "").trim();

      if (!organizationId || !propertyId) {
        return res.status(400).json({ ok: false, error: "Missing organizationId or propertyId" });
      }

      // 1) validar propiedad pertenece a org
      const prop = await prisma.property.findFirst({
        where: { id: propertyId, organizationId },
        select: { id: true },
      });
      if (!prop) {
        return res.status(404).json({ ok: false, error: "PROPERTY_NOT_FOUND_FOR_ORG" });
      }

      // 2) cargar TTLockAuth
      const auth = await prisma.tTLockAuth.findUnique({
        where: { organizationId },
        select: { accessToken: true, refreshToken: true, expiresAt: true, uid: true },
      });

      if (!auth?.refreshToken) {
        return res.status(401).json({ ok: false, error: "TTLOCK_NOT_CONNECTED" });
      }

      // 3) refresh si no hay accessToken o si expira en < 2 min
      const now = Date.now();
      const expiresAtMs = auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0;
      const shouldRefresh = !auth.accessToken || !auth.expiresAt || expiresAtMs - now < 2 * 60 * 1000;

      let accessToken = auth.accessToken ?? "";

      if (shouldRefresh) {
        const refreshed = await ttlockRefreshAccessToken(auth.refreshToken);

        const newAccess = refreshed.access_token;
        const newRefresh = refreshed.refresh_token ?? auth.refreshToken;
        const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

        await prisma.tTLockAuth.update({
          where: { organizationId },
          data: {
            accessToken: newAccess,
            refreshToken: newRefresh,
            expiresAt: newExpiresAt,
            uid: refreshed.uid ?? auth.uid ?? undefined,
          },
        });

        accessToken = newAccess;
      }

      if (!accessToken) {
        return res.status(409).json({ ok: false, error: "TTLOCK_NOT_CONNECTED" });
      }

      // 4) listar locks desde TTLock
      const resp = await ttlockListLocksWithAccessToken(accessToken, 1, 100);
      const list = Array.isArray(resp?.list) ? resp.list : [];

      // 5) upsert a Prisma
      let created = 0;
      let updated = 0;

      const upserted = [];
      for (const l of list) {
        const ttlockLockId = Number(l.lockId);
        if (!Number.isFinite(ttlockLockId) || ttlockLockId <= 0) continue;

        const ttlockLockName = String(l.lockName ?? l.lockAlias ?? "").trim() || null;

        const existing = await prisma.lock.findUnique({
          where: { ttlockLockId },
          select: { id: true },
        });

        const lock = await prisma.lock.upsert({
          where: { ttlockLockId },
          create: {
            ttlockLockId,
            ttlockLockName,
            propertyId,
            isActive: true,
          },
          update: {
            ttlockLockName,
            propertyId,
            isActive: true,
          },
          select: { id: true, ttlockLockId: true, ttlockLockName: true, propertyId: true, isActive: true },
        });

        if (existing) updated++;
        else created++;

        upserted.push(lock);
      }

      return res.json({
        ok: true,
        organizationId,
        propertyId,
        created,
        updated,
        totalFromTtlock: list.length,
        locks: upserted,
      });
    } catch (e: any) {
      console.error("org/ttlock/sync-locks error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "sync locks failed" });
    }
  });

  return router;
}
