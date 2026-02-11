// src/routes/reservation.routes.ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";
import { ttlockGetPasscode } from "../ttlock/ttlock.passcode";

export function buildReservationRouter(_prisma: PrismaClient) {
  const router = Router();

  /**
   * CHECK-IN:
   * - activa NFC por periodo (gateway)
   * - genera One-time passcode (backup)
   */
  router.post("/checkin", async (req, res) => {
    try {
      const { lockId, cardId, startDate, endDate, guestName } = req.body ?? {};

      if (!lockId || !cardId || !startDate || !endDate) {
        return res.status(400).json({
          ok: false,
          error: "Missing lockId, cardId, startDate, endDate",
        });
      }

      // 1) Activar NFC por periodo (gateway)
      const cardResult = await ttlockChangeCardPeriod({
        lockId: Number(lockId),
        cardId: Number(cardId),
        startDate: Number(startDate),
        endDate: Number(endDate),
        changeType: 2, // 2 = gateway
      });

      // 2) One-time passcode (type=1) como backup
      let passcode: any = null;
      try {
        passcode = await ttlockGetPasscode({
          lockId: Number(lockId),
          keyboardPwdType: 1,
          name: guestName ? String(guestName) : "PinGo Guest",
        });
      } catch (e: any) {
        passcode = { ok: false, error: e?.message ?? String(e) };
      }

      return res.json({
        ok: true,
        lockId: Number(lockId),
        cardId: Number(cardId),
        startDate: Number(startDate),
        endDate: Number(endDate),
        cardResult,
        passcode,
      });
    } catch (e: any) {
      console.error("reservation/checkin error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "checkin failed" });
    }
  });

  /**
   * CHECK-OUT:
   * - revoca vigencia de la NFC (NO borra), poniendo endDate = now
   */
  router.post("/checkout", async (req, res) => {
    try {
      const { lockId, cardId } = req.body ?? {};
      if (!lockId || !cardId) {
        return res.status(400).json({ ok: false, error: "Missing lockId or cardId" });
      }

      const now = Date.now();

      const cardResult = await ttlockChangeCardPeriod({
        lockId: Number(lockId),
        cardId: Number(cardId),
        startDate: now,
        endDate: now,
        changeType: 2, // gateway
      });

      return res.json({
        ok: true,
        lockId: Number(lockId),
        cardId: Number(cardId),
        revokedAt: now,
        cardResult,
      });
    } catch (e: any) {
      console.error("reservation/checkout error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "checkout failed" });
    }
  });

  return router;
}
