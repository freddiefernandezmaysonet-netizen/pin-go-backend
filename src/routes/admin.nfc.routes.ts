// src/routes/admin.nfc.routes.ts
import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { ttlockListCards } from "../ttlock/ttlock.card";

export function buildAdminNfcRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * POST /api/admin/nfc/import-from-ttlock
   * Body: { propertyId, ttlockLockId, pageNo?, pageSize? }
   *
   * Lee las tarjetas desde TTLock y las guarda en NfcCard como AVAILABLE.
   * Evita duplicados por @@unique([propertyId, ttlockCardId])
   */
  router.post("/nfc/import-from-ttlock", async (req, res) => {
    try {
      const { propertyId, ttlockLockId, pageNo, pageSize } = req.body ?? {};

      if (!propertyId || !ttlockLockId) {
        return res.status(400).json({ ok: false, error: "Missing propertyId, ttlockLockId" });
      }

      const resp = await ttlockListCards({
        lockId: Number(ttlockLockId),
        pageNo: Number(pageNo ?? 1),
        pageSize: Number(pageSize ?? 50),
      });

      const list = Array.isArray(resp?.list) ? resp.list : [];
      const imported: any[] = [];
      const skipped: any[] = [];

      for (const item of list) {
        const ttlockCardId = Number(item?.cardId);
        if (!ttlockCardId) continue;

        try {
           
      const row = await prisma.nfcCard.upsert({
        where: {
          propertyId_ttlockCardId: {
            propertyId: String(propertyId),
            ttlockCardId: Number(ttlockCardId),
          },
        },
        create: {
          propertyId: String(propertyId),
          ttlockCardId: Number(ttlockCardId),
          label,
          status: NfcCardStatus.AVAILABLE,
        },
        update: {
         label,
        // NO toques status aquí
      },
   });
        
          imported.push({ id: row.id, ttlockCardId: row.ttlockCardId, label: row.label });
        } catch (e: any) {
          // Duplicado u otro error
          skipped.push({ ttlockCardId, reason: String(e?.message ?? e) });
        }
      }

      return res.json({
        ok: true,
        propertyId: String(propertyId),
        ttlockLockId: Number(ttlockLockId),
        ttlockTotal: resp?.total ?? null,
        importedCount: imported.length,
        skippedCount: skipped.length,
        imported,
        // si no quieres ver errores largos, puedes comentar skipped
        skipped,
      });
    } catch (e: any) {
      console.error("admin nfc import error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "import failed" });
    }
  });

  return router;
}
