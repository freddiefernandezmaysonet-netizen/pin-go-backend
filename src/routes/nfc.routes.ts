// src/routes/nfc.routes.ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { ttlockChangeCardPeriod, ttlockListCards, ttlockDeleteCard } from "../ttlock/ttlock.card";

export function buildNfcRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * POST /nfc/change-period
   * Reusable: cambia vigencia de una tarjeta ya enrollada
   * Body: { ttlockLockId, cardId, startDateISO, endDateISO }
   */
  router.post("/change-period", async (req, res) => {
    try {
      const { ttlockLockId, cardId, startDateISO, endDateISO } = req.body ?? {};

      if (!ttlockLockId || !cardId || !startDateISO || !endDateISO) {
        return res.status(400).json({
          ok: false,
          error: "Missing ttlockLockId, cardId, startDateISO, endDateISO",
        });
      }

      const start = new Date(String(startDateISO));
      const end = new Date(String(endDateISO));

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        return res.status(400).json({ ok: false, error: "Invalid start/end" });
      }

      // opcional: valida lock en tu DB
      const lock = await prisma.lock.findUnique({ where: { ttlockLockId: Number(ttlockLockId) } });
      if (!lock) return res.status(404).json({ ok: false, error: "Lock not found" });

      const resp = await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(cardId),
        startDate: start.getTime(),
        endDate: end.getTime(),
        changeType: 2,
      });

      return res.json({ ok: true, ttlockResponse: resp });
    } catch (e: any) {
      console.error("nfc/change-period error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "change-period failed" });
    }
  });

  /**
   * POST /nfc/list
   * Body: { ttlockLockId, pageNo?, pageSize? }
   */
  router.post("/list", async (req, res) => {
    try {
      const { ttlockLockId, pageNo, pageSize } = req.body ?? {};
      if (!ttlockLockId) return res.status(400).json({ ok: false, error: "Missing ttlockLockId" });

      const resp = await ttlockListCards({
        lockId: Number(ttlockLockId),
        pageNo: Number(pageNo ?? 1),
        pageSize: Number(pageSize ?? 20),
      });

      return res.json({ ok: true, ttlockResponse: resp });
    } catch (e: any) {
      console.error("nfc/list error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "list failed" });
    }
  });

  /**
   * POST /nfc/delete
   * (Opcional para operaciones)
   * Body: { ttlockLockId, cardId }
   */
  router.post("/delete", async (req, res) => {
    try {
      const { ttlockLockId, cardId } = req.body ?? {};
      if (!ttlockLockId || !cardId) {
        return res.status(400).json({ ok: false, error: "Missing ttlockLockId, cardId" });
      }

      const resp = await ttlockDeleteCard({
        lockId: Number(ttlockLockId),
        cardId: Number(cardId),
        deleteType: 2,
      });

      return res.json({ ok: true, ttlockResponse: resp });
    } catch (e: any) {
      console.error("nfc/delete error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "delete failed" });
    }
  });

  return router;
}
