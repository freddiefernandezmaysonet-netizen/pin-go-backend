import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  refreshNfcPoolFromTTLock,
  dedupeNfcCards,
  countAvailableCardsByKind,
} from "../services/nfc.service";
import {
  ttlockRefreshAccessToken,
  ttlockGetAccessToken,
} from "../ttlock/ttlock.service";

async function resolveOrgTtlockAccessToken(
  prisma: PrismaClient,
  req: any,
  propertyId: string
) {
  const orgIdFromReq =
    req?.user?.organizationId ??
    req?.organizationId ??
    req?.orgId ??
    null;

  let organizationId = orgIdFromReq as string | null;

  if (!organizationId) {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { organizationId: true },
    });

    organizationId = property?.organizationId ?? null;
  }

  if (!organizationId) {
    throw new Error("Could not resolve organizationId for NFC sync");
  }

  console.log("ORG ID:", organizationId);

  const auth = await prisma.tTLockAuth.findUnique({
    where: { organizationId },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      uid: true,
    },
  });

  if (!auth) {
    throw new Error("TTLockAuth not configured for this organization");
  }

  const now = Date.now();
  const expiresAtMs = auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0;

  // margen de seguridad de 5 minutos
  const stillValid =
    !!auth.accessToken && !!auth.expiresAt && expiresAtMs > now + 5 * 60 * 1000;

  if (stillValid) {
    console.log("✅ TTLock usando accessToken guardado para org:", organizationId);
    return auth.accessToken as string;
  }

  if (auth.refreshToken) {
    const refreshed = await ttlockRefreshAccessToken({
      refreshToken: auth.refreshToken,
    });

    await prisma.tTLockAuth.update({
      where: { organizationId },
      data: {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? auth.refreshToken,
        uid: refreshed.uid ?? auth.uid ?? null,
        expiresAt: new Date(Date.now() + Number(refreshed.expires_in ?? 0) * 1000),
      },
    });

    console.log("✅ TTLock refresh token OK para org:", organizationId);
    return refreshed.access_token;
  }

  console.warn(
    "⚠️ TTLockAuth sin refreshToken para org, usando fallback env:",
    organizationId
  );

  const fallback = await ttlockGetAccessToken();
  return fallback.access_token;
}

export default function buildNfcSyncRouter(prisma: PrismaClient) {
  const router = Router();

  router.get("/cards", async (req, res) => {
    try {
      const propertyId = String(req.query.propertyId ?? "");

      if (!propertyId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId",
        });
      }

      const cards = await prisma.nfcCard.findMany({
        where: { propertyId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          ttlockCardId: true,
          label: true,
          status: true,
          createdAt: true,
        },
      });

      return res.json({
        ok: true,
        items: cards,
      });
    } catch (e: any) {
      console.error("NFC cards fetch failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "cards fetch failed",
      });
    }
  });

  router.get("/stats", async (req, res) => {
    try {
      const propertyId = String(req.query.propertyId ?? "");

      if (!propertyId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId",
        });
      }

      const stats = await countAvailableCardsByKind(prisma, {
        propertyId,
      });

      return res.json({
        ok: true,
        stats,
      });
    } catch (e: any) {
      console.error("NFC stats failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "stats failed",
      });
    }
  });

  router.post("/sync", async (req: any, res) => {
    try {
      const { propertyId, ttlockLockId } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId or ttlockLockId",
        });
      }

      const accessToken = await resolveOrgTtlockAccessToken(
        prisma,
        req,
        String(propertyId)
      );

      const rawResult = await refreshNfcPoolFromTTLock(prisma, {
        propertyId: String(propertyId),
        ttlockLockId: Number(ttlockLockId),
        accessToken,
        minTotals: {
          guest: 0,
          cleaning: 0,
        },
      });

      console.log("NFC SYNC RESULT >>>", rawResult);

      return res.json({
        ok: true,
        message: "NFC pool synchronized from TTLock",
        result: {
          importedCount: Number(rawResult?.upsertedCount ?? 0),
          updatedCount: 0,
          totalFromTtlock: Number(rawResult?.ttlockTotal ?? 0),
          totalAvailable: Number(rawResult?.upsertedCount ?? 0),
          totalGuest: Number(rawResult?.guestTotal ?? 0),
          totalCleaning: Number(rawResult?.cleaningTotal ?? 0),
          retiredCount: Number(rawResult?.retiredCount ?? 0),
        },
      });
    } catch (e: any) {
      console.error("NFC sync failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "sync failed",
      });
    }
  });

  router.post("/dedupe", async (req, res) => {
    try {
      const { propertyId } = req.body ?? {};

      if (!propertyId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId",
        });
      }

      const out = await dedupeNfcCards(prisma, String(propertyId));
      return res.json(out);
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: e?.message ?? String(e),
      });
    }
  });

  return router;
}