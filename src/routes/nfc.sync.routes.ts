import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  refreshNfcPoolFromTTLock,
  dedupeNfcCards,
  countAvailableCardsByKind,
} from "../services/nfc.service";
import { getPropertyTtlockAccessToken } from "../services/ttlock/ttlock.org-auth";

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

  router.post("/sync", async (req, res) => {
    try {
      const { propertyId, ttlockLockId } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing propertyId or ttlockLockId",
        });
      }

      const accessToken = await getPropertyTtlockAccessToken(
        prisma,
        String(propertyId)
      );

      // safe migration:
      // - if nfc.service.ts already supports accessToken, lo usará
      // - if todavía no lo usa, ignorará la propiedad extra
      const syncParams: any = {
        propertyId: String(propertyId),
        ttlockLockId: Number(ttlockLockId),
        accessToken,
        minTotals: {
          guest: 0,
          cleaning: 0,
        },
      };

      const rawResult = await refreshNfcPoolFromTTLock(prisma, syncParams);

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