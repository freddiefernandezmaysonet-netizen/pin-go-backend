//src/routes/org.ttlock.inventory.router.ts

import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { ttlockListLocksWithAccessToken } from "../ttlock/ttlock.api";
import { requireOrg } from "../middleware/requireOrg";

const TTLOCK_TIMEOUT_MS = 15000;

type ExistingLockRow = {
  id: string;
  ttlockLockId: number;
  ttlockLockName: string | null;
  propertyId: string;
  isActive: boolean;
  property: {
    id: string;
    name: string;
  } | null;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function buildOrgTtlockInventoryRouter(prisma: PrismaClient) {
  const router = Router();

  router.use(requireOrg(prisma));

  async function ttlockRefreshAccessToken(refreshToken: string) {
    const base = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";
    const client_id = process.env.TTLOCK_CLIENT_ID ?? "";
    const client_secret = process.env.TTLOCK_CLIENT_SECRET ?? "";

    if (!client_id || !client_secret) {
      throw new Error("TTLOCK_CLIENT_ID/TTLOCK_CLIENT_SECRET not configured");
    }

    const resp = await withTimeout(
      fetch(`${base}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id,
          client_secret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          date: String(Date.now()),
        }),
      }),
      TTLOCK_TIMEOUT_MS,
      "TTLOCK_REFRESH"
    );

    const text = await resp.text();

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `TTLock refresh returned non-JSON. First 120 chars: ${text.slice(0, 120)}`
      );
    }

    if (!resp.ok) {
      throw new Error(`TTLock refresh HTTP ${resp.status}: ${JSON.stringify(data)}`);
    }

    if (data?.errcode) {
      throw new Error(
        `TTLock refresh errcode=${data.errcode} errmsg=${data.errmsg ?? "unknown"}`
      );
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

  async function getValidAccessTokenForOrg(organizationId: string) {
    const auth = await prisma.tTLockAuth.findUnique({
      where: { organizationId },
      select: {
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
        uid: true,
      },
    });

    if (!auth?.refreshToken) {
      return { ok: false as const, status: 401, error: "TTLOCK_NOT_CONNECTED" };
    }

    const now = Date.now();
    const expiresAtMs = auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0;
    const shouldRefresh =
      !auth.accessToken || !auth.expiresAt || expiresAtMs - now < 2 * 60 * 1000;

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
      return { ok: false as const, status: 409, error: "TTLOCK_NOT_CONNECTED" };
    }

    return { ok: true as const, accessToken };
  }

  /**
   * GET /api/org/ttlock/inventory
   * Query:
   *   - propertyId? -> opcional, solo para calcular availableForSwap relativo a esa property
   *
   * Importante:
   * - Hace pull neutral desde TTLock
   * - NO reasigna locks a ninguna property
   * - NO activa/desactiva locks
   */
  router.get("/ttlock/inventory", async (req, res) => {
    try {
      const organizationId = String((req as any).orgId ?? "").trim();
      const propertyId =
        typeof req.query.propertyId === "string" ? req.query.propertyId.trim() : "";

      if (!organizationId) {
        return res.status(401).json({ ok: false, error: "ORG_CONTEXT_MISSING" });
      }

      if (propertyId) {
        const prop = await prisma.property.findFirst({
          where: { id: propertyId, organizationId },
          select: { id: true },
        });

        if (!prop) {
          return res
            .status(404)
            .json({ ok: false, error: "PROPERTY_NOT_FOUND_FOR_ORG" });
        }
      }

      const tokenResult = await getValidAccessTokenForOrg(organizationId);
      if (!tokenResult.ok) {
        return res
          .status(tokenResult.status)
          .json({ ok: false, error: tokenResult.error });
      }

      const resp = await withTimeout(
        ttlockListLocksWithAccessToken(tokenResult.accessToken, 1, 100),
        TTLOCK_TIMEOUT_MS,
        "TTLOCK_LIST_LOCKS"
      );

      const remoteLocks = Array.isArray((resp as any)?.list) ? (resp as any).list : [];

      const ttlockIds = remoteLocks
        .map((l: any) => Number(l.lockId))
        .filter((n: number) => Number.isFinite(n) && n > 0);

      const existingLocks: ExistingLockRow[] = ttlockIds.length
        ? await prisma.lock.findMany({
            where: {
              ttlockLockId: { in: ttlockIds },
              property: { organizationId },
            },
            select: {
              id: true,
              ttlockLockId: true,
              ttlockLockName: true,
              propertyId: true,
              isActive: true,
              property: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        : [];

      const existingByTtlockId = new Map(
        existingLocks.map((l) => [l.ttlockLockId, l])
      );

      const locks = remoteLocks
        .map((l: any) => {
          const ttlockLockId = Number(l.lockId);
          if (!Number.isFinite(ttlockLockId) || ttlockLockId <= 0) return null;

          const remoteName =
            String(l.lockName ?? l.lockAlias ?? "").trim() || null;

          const existing = existingByTtlockId.get(ttlockLockId) ?? null;

          const availableForActivation = !existing || !existing.isActive;

          const availableForSwap =
            !existing ||
            !existing.isActive ||
            (propertyId ? existing.propertyId === propertyId : true);

          return {
            ttlockLockId,
            name: remoteName,
            registered: Boolean(existing),
            availableForActivation,
            availableForSwap,
            existingLock: existing
              ? {
                  id: existing.id,
                  ttlockLockId: existing.ttlockLockId,
                  name: existing.ttlockLockName ?? null,
                  isActive: existing.isActive,
                  propertyId: existing.propertyId,
                  property: existing.property,
                }
              : null,
          };
        })
        .filter(Boolean);

      return res.json({
        ok: true,
        organizationId,
        propertyId: propertyId || null,
        totalFromTtlock: remoteLocks.length,
        locks,
      });
    } catch (e: any) {
      console.error("org/ttlock/inventory error:", e?.message ?? e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "inventory pull failed",
      });
    }
  });

  return router;
}