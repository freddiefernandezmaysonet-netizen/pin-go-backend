import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { refreshNfcPoolFromTTLock, dedupeNfcCards } from "../services/nfc.service";

export default function buildNfcSyncRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * GET /access/nfc/cards?propertyId=...
   */
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

  /**
   * POST /access/nfc/sync
   * Body:
   * {
   *   propertyId: string,
   *   ttlockLockId: number
   * }
   */
  router.post("/sync", async (req, res) => {
    try {
      const { propertyId, ttlockLockId } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId or ttlockLockId",
        });
      }

      const rawResult = await refreshNfcPoolFromTTLock(prisma, {
        propertyId: String(propertyId),
        ttlockLockId: Number(ttlockLockId),
        minTotals: {
          guest: 0,
          cleaning: 0,
        },
      });

      console.log("NFC SYNC RESULT >>>", rawResult);

      const result = {
        importedCount: Number(
          (rawResult as any)?.importedCount ??
            (rawResult as any)?.imported ??
            0
        ),
        updatedCount: Number(
          (rawResult as any)?.updatedCount ??
            (rawResult as any)?.updated ??
            0
        ),
        totalFromTtlock: Number(
          (rawResult as any)?.totalFromTtlock ??
            (rawResult as any)?.total ??
            (rawResult as any)?.totalCards ??
            0
        ),
        totalAvailable: Number((rawResult as any)?.totalAvailable ?? 0),
        totalGuest: Number((rawResult as any)?.totalGuest ?? 0),
        totalCleaning: Number((rawResult as any)?.totalCleaning ?? 0),
      };

      return res.json({
        ok: true,
        message: "NFC pool synchronized from TTLock",
        result,
        rawResult,
      });
    } catch (e: any) {
      console.error("NFC sync failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "sync failed",
      });
    }
  });

  /**
   * POST /access/nfc/dedupe
   * Body:
   * {
   *   propertyId: string
   * }
   */
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