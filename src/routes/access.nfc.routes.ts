// src/routes/access.nfc.routes.ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  assignNfcCards,
  unassignAllNfcForReservation,
  refreshNfcPoolFromTTLock,
  countAvailableCardsByKind,
} from "../services/nfc.service";
import { computeCleaningWindow } from "../services/cleaning-window.service";

export function buildAccessNfcRouter(prisma: PrismaClient) {
  const router = Router();

  /**
   * POST /access/nfc/assign
   * Body: { reservationId, ttlockLockId, guestCount?, cleaningCount? }
   * Defaults: guestCount=2, cleaningCount=1
   */
  router.post("/assign", async (req, res) => {
    try {
     const { reservationId, ttlockLockId, guestCount, cleaningCount, force } = req.body ?? {};
       if (!reservationId || !ttlockLockId) {
        return res.status(400).json({ ok: false, error: "Missing reservationId, ttlockLockId" });
      }

      const reservation = await prisma.reservation.findUnique({ where: { id: String(reservationId) } });
      if (!reservation) return res.status(404).json({ ok: false, error: "Reservation not found" });
 
     const property = await prisma.property.findUnique({
  where: { id: reservation.propertyId },
  select: {
    cleaningStartOffsetMinutes: true,
    cleaningDurationMinutes: true,
  },
});
if (!property) return res.status(404).json({ ok: false, error: "Property not found" });

const { start: cleaningStart, end: cleaningEnd } = computeCleaningWindow({
  checkOut: reservation.checkOut,
  cleaningStartOffsetMinutes: property.cleaningStartOffsetMinutes ?? 30,
  cleaningDurationMinutes: property.cleaningDurationMinutes ?? 180,
});

     const lock = await prisma.lock.findUnique({ where: { ttlockLockId: Number(ttlockLockId) } });
      if (!lock) return res.status(404).json({ ok: false, error: "Lock not found" });

      const gCount = Number(guestCount ?? 2);
      const cCount = Number(cleaningCount ?? 1);

      if (gCount < 0 || cCount < 0) {
        return res.status(400).json({ ok: false, error: "guestCount/cleaningCount must be >= 0" });
      }

    // 0) Idempotencia: si ya existen assignments ACTIVE para esta reserva, no crear duplicados
const existingActive = await prisma.nfcAssignment.findMany({
  where: {
    reservationId: reservation.id,
    status: "ACTIVE",
  },
  include: { nfcCard: true },
  orderBy: { createdAt: "asc" },
});

if (existingActive.length > 0 && !force) {
  // Devuelve lo que ya está asignado (modo idempotente)
  const guestAssigned = existingActive.filter(a => a.role === "GUEST").length;
  const cleaningAssigned = existingActive.filter(a => a.role === "CLEANING").length;

  return res.json({
    ok: true,
    reservationId: reservation.id,
    reusedExisting: true,
    assignedTotal: existingActive.length,
    guestAssigned,
    cleaningAssigned,
    assignments: existingActive,
    note: "Assignments already ACTIVE for this reservation. Pass force=true to reassign.",
  });
}

   if (existingActive.length > 0 && force) {
  // Termina (unassign) lo anterior antes de reasignar
  await unassignAllNfcForReservation(prisma, {
    reservationId: reservation.id,
    ttlockLockId: Number(ttlockLockId),
  });
}

      // 0) REFRESH pool desde TTLock + validar mínimos (4 Guest / 2 Cleaning)
const refresh = await refreshNfcPoolFromTTLock(prisma, {
  propertyId: String(reservation.propertyId),
  ttlockLockId: Number(ttlockLockId),
  minTotals: { guest: 4, cleaning: 2 },
});

// 0.1) Validar que haya AVAILABLE suficiente para esta asignación
const avail = await countAvailableCardsByKind(prisma, {
  propertyId: String(reservation.propertyId),
});

if (gCount > 0 && avail.guest < gCount) {
  return res.status(400).json({
    ok: false,
    error: `Not enough AVAILABLE GUEST cards. Needed=${gCount} found=${avail.guest}. (TTLock guestTotal=${refresh.guestTotal})`,
  });
}

if (cCount > 0 && avail.cleaning < cCount) {
  return res.status(400).json({
    ok: false,
    error: `Not enough AVAILABLE CLEANING cards. Needed=${cCount} found=${avail.cleaning}. (TTLock cleaningTotal=${refresh.cleaningTotal})`,
  });
}
      const guestStartsAt = new Date(reservation.checkIn);
      const guestEndsAt = new Date(reservation.checkOut);

      const assigned: any[] = [];
   
      // 1) Asigna tarjetas de huésped
      if (gCount > 0) {
  const a = await assignNfcCards(prisma, {
    reservationId: reservation.id,
    ttlockLockId: Number(ttlockLockId),
    propertyId: String(reservation.propertyId),
    role: "GUEST",
    startsAt: guestStartsAt,
    endsAt: guestEndsAt,
    count: gCount,
  });
  assigned.push(...a);
}

     // 2) Asigna tarjetas de limpieza (ventana: checkout + offset, duración configurable)
     if (cCount > 0) {
  const { start: cleaningStart, end: cleaningEnd } = computeCleaningWindow({
    checkOut: reservation.checkOut,
    cleaningStartOffsetMinutes: property.cleaningStartOffsetMinutes ?? 30,
    cleaningDurationMinutes: property.cleaningDurationMinutes ?? 180,
  });

  const a = await assignNfcCards(prisma, {
    reservationId: reservation.id,
    ttlockLockId: Number(ttlockLockId),
    propertyId: String(reservation.propertyId),
    role: "CLEANING",
    startsAt: cleaningStart,
    endsAt: cleaningEnd,
    count: cCount,
  });

  assigned.push(...a);
}
    
return res.json({
        ok: true,
        reservationId: reservation.id,
        assignedTotal: assigned.length,
        guestAssigned: gCount,
        cleaningAssigned: cCount,
        assignments: assigned,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "assign failed" });
    }
  });

  /**
   * POST /access/nfc/unassign
   * Body: { reservationId, ttlockLockId }
   * Vence TODAS las tarjetas activas (guest + cleaning) y las libera en el pool.
   */
  router.post("/unassign", async (req, res) => {
    try {
      const { reservationId, ttlockLockId } = req.body ?? {};
      if (!reservationId || !ttlockLockId) {
        return res.status(400).json({ ok: false, error: "Missing reservationId, ttlockLockId" });
      }

      const reservation = await prisma.reservation.findUnique({ where: { id: String(reservationId) } });
      if (!reservation) return res.status(404).json({ ok: false, error: "Reservation not found" });

      const result = await unassignAllNfcForReservation(prisma, {
        reservationId: reservation.id,
        ttlockLockId: Number(ttlockLockId),
      });

      return res.json({ ok: true, reservationId: reservation.id, ...result });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "unassign failed" });
    }
  });

  return router;
}
