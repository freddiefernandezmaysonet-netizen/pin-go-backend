import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { refreshNfcPoolFromTTLock } from "../services/nfc.service";
import { dedupeNfcCards } from "../services/nfc.service"; // ajusta path

const prisma = new PrismaClient();
const router = Router();

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

    const result = await refreshNfcPoolFromTTLock(prisma, {
      propertyId: String(propertyId),
      ttlockLockId: Number(ttlockLockId),
      minTotals: {
        guest: 0,
        cleaning: 0,
      },
    });

    return res.json({
      ok: true,
      message: "NFC pool synchronized from TTLock",
      result,
    });
  } catch (e: any) {
    console.error("NFC sync failed:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "sync failed",
    });
  }
});

export default function buildNfcSyncRouter(prisma: PrismaClient) {
  const router = Router();

  router.post("/dedupe", async (req, res) => {
    try {
      const { propertyId } = req.body ?? {};
      if (!propertyId) return res.status(400).json({ ok: false, error: "Missing propertyId" });

      const out = await dedupeNfcCards(prisma, String(propertyId));
      return res.json(out);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  return router;
}

