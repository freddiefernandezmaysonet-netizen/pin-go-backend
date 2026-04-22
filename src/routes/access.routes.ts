// src/routes/access.routes.ts
import { Router } from "express";
import { PrismaClient, AccessMethod, AccessStatus } from "@prisma/client";
import {
  ttlockGetPasscode,
  ttlockCreatePasscode,
  ttlockDeletePasscode,
} from "../ttlock/ttlock.passcode";

import { sendGuestSms } from "../services/sms.service";

export function buildAccessRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * POST /access/checkin
   * Crea Reservation + genera OTP (TTLock GET) y crea AccessGrant asociado.
   * (Custom passcode con teléfono lo puedes activar luego con ttlockCreatePasscode)
   */
  router.post("/checkin", async (req, res) => {
    try {
      const { propertyId, ttlockLockId, guestName, guestPhone, guestEmail, roomName, checkIn, checkOut } =
        req.body ?? {};

      if (!propertyId || !ttlockLockId || !guestName || !checkIn || !checkOut) {
        return res.status(400).json({
          ok: false,
          error: "Missing required fields: propertyId, ttlockLockId, guestName, checkIn, checkOut",
        });
      }

      const start = new Date(checkIn);
      const end = new Date(checkOut);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid checkIn/checkOut date format (use ISO string)" });
      }
      if (end <= start) return res.status(400).json({ ok: false, error: "checkOut must be after checkIn" });

      // 1) Verifica lock por ttlockLockId
      const lock = await prisma.lock.findUnique({ where: { ttlockLockId: Number(ttlockLockId) } });
      if (!lock) {
        return res.status(404).json({ ok: false, error: `Lock not found for ttlockLockId=${ttlockLockId}` });
      }
      if (lock.propertyId !== String(propertyId)) {
        return res.status(400).json({ ok: false, error: "Lock does not belong to this propertyId" });
      }

      // 2) Crea Reservation
      const reservation = await prisma.reservation.create({
        data: {
          propertyId: String(propertyId),
          guestName: String(guestName),
          guestEmail: guestEmail ? String(guestEmail) : null,
          guestPhone: guestPhone ? String(guestPhone) : null,
          roomName: roomName ? String(roomName) : "Default",
          checkIn: start,
          checkOut: end,
          paymentState: "NONE", // ajusta a tu enum si difiere
        },
      });

	// 3) Genera passcode custom (últimos 7 dígitos del teléfono)
       const digits = guestPhone ? String(guestPhone).replace(/\D/g, "") : "";
       const codeToUse = digits.length >= 7 ? digits.slice(-7) : null;

       if (!codeToUse) {
         return res.status(400).json({
         ok: false,
         error: "guestPhone is required to generate custom 7-digit passcode",
  });
}

       const pass = await ttlockCreatePasscode({
       lockId: Number(ttlockLockId),
       code: codeToUse,
       startDate: start.getTime(),
       endDate: end.getTime(),
       addType: 2, // gateway
       name: `Pin&Go ${reservation.id}`,
  });

      
      

      // 4)Para ADD (custom), el código es el que tú enviaste
      const keyboardPwd = String(codeToUse);

      // TTLock ADD devuelve el ID del passcode (a veces con nombres distintos)
      const keyboardPwdIdRaw =
        (pass as any).keyboardPwdId ??
        (pass as any).pwdId ??
        (pass as any).id ??
        (pass as any).kid;

      const keyboardPwdId = keyboardPwdIdRaw ? Number(keyboardPwdIdRaw) : null;

      if (!keyboardPwdId) {
        return res.status(500).json({
          ok: false,
          error: "TTLock ADD did not return a keyboardPwdId-like field",
          ttlockResponse: pass, // 👈 esto nos dice el nombre real del campo
        });
      }
     
     
      // 5) Crea AccessGrant y GUARDA ttlockKeyboardPwdId (necesario para borrar en checkout)
      const grant = await prisma.accessGrant.create({
        data: {
          lockId: lock.id,
          reservationId: reservation.id,
          method: AccessMethod.PASSCODE_TIMEBOUND,
          status: AccessStatus.ACTIVE,
          startsAt: start,
          endsAt: end,
          unlockKey: "#",
          accessCodeMasked: keyboardPwd.slice(0, 3) + "*****",
          ttlockKeyboardPwdId: keyboardPwdId,
          ttlockPayload: pass,
        },
      });

      // (Opcional) SMS — deja esto como "try" para no romper checkin si Twilio falla
      try {
        if (guestPhone) {
          await sendGuestSms(String(guestPhone), `Tu código Pin&Go es: ${keyboardPwd}`);
        }
      } catch (e) {
        console.warn("sendGuestSms failed:", (e as any)?.message ?? e);
      }

      return res.json({
        ok: true,
        reservation,
        accessGrant: grant,
        otp: keyboardPwd,
        otpId: keyboardPwdId,
        note: "NFC activation will be added after confirming card endpoints.",
      });
    } catch (e: any) {
      console.error("access/checkin error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "checkin failed" });
    }
  });

  /**
   * POST /access/checkout
   * Borra passcodes en TTLock (si hay ttlockKeyboardPwdId) y revoca en DB.
   */
  router.post("/checkout", async (req, res) => {
    try {
      const { reservationId, ttlockLockId } = req.body ?? {};

      if (!reservationId) {
        return res.status(400).json({ ok: false, error: "Missing reservationId" });
      }
      if (!ttlockLockId) {
        return res.status(400).json({ ok: false, error: "Missing ttlockLockId" });
      }

      const reservation = await prisma.reservation.findUnique({
        where: { id: String(reservationId) },
      });
      if (!reservation) {
        return res.status(404).json({ ok: false, error: "Reservation not found" });
      }

      // 1) Buscar grants asociados (incluye FAILED por idempotencia)
      const grants = await prisma.accessGrant.findMany({
        where: {
          reservationId: reservation.id,
          status: { in: [AccessStatus.ACTIVE, AccessStatus.PENDING, AccessStatus.FAILED] },
        },
      });

      // 2) Borrar passcodes en TTLock
      for (const g of grants) {
        if (!g.ttlockKeyboardPwdId) continue;

        try {
          await ttlockDeletePasscode({
            lockId: Number(ttlockLockId),
            keyboardPwdId: Number(g.ttlockKeyboardPwdId),
            deleteType: 2,
          });
        } catch (e: any) {
          // No tumbes todo checkout si TTLock falla
          await prisma.accessGrant.update({
            where: { id: g.id },
            data: {
              status: AccessStatus.FAILED,
              lastError: String(e?.message ?? e),
            },
          });
        }
      }

      // 3) Revocar en DB (una sola vez)
      const updated = await prisma.accessGrant.updateMany({
        where: {
          reservationId: reservation.id,
          status: { in: [AccessStatus.ACTIVE, AccessStatus.PENDING, AccessStatus.FAILED] },
        },
        data: { status: AccessStatus.REVOKED },
      });

      return res.json({
        ok: true,
        reservationId: reservation.id,
        revokedGrants: updated.count,
      });
    } catch (e: any) {
      console.error("access/checkout error:", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? "checkout failed" });
    }
  });

  return router;
}
