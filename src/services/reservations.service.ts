import crypto from "crypto";
import { PrismaClient, AccessStatus, PaymentState, AccessMethod } from "@prisma/client";
import type { Request, Response } from "express";

const prisma = new PrismaClient();

export async function createReservationHandler(req: Request, res: Response) {
  try {
    const body = req.body ?? {};

    // ---- Validaciones básicas (ajusta según tu DTO real) ----
    if (!body.propertyId) return res.status(400).json({ error: "Missing propertyId" });
    if (!body.lockId) return res.status(400).json({ error: "Missing lockId" });
    if (!body.guestName) return res.status(400).json({ error: "Missing guestName" });
    if (!body.checkIn) return res.status(400).json({ error: "Missing checkIn" });
    if (!body.checkOut) return res.status(400).json({ error: "Missing checkOut" });

    const checkIn = new Date(body.checkIn);
    const checkOut = new Date(body.checkOut);
    if (Number.isNaN(checkIn.getTime())) return res.status(400).json({ error: "Invalid checkIn" });
    if (Number.isNaN(checkOut.getTime())) return res.status(400).json({ error: "Invalid checkOut" });
    if (checkOut <= checkIn) return res.status(400).json({ error: "checkOut must be after checkIn" });

    const paymentState: PaymentState = (body.paymentState as PaymentState) ?? PaymentState.NONE;
    const method: AccessMethod = (body.method as AccessMethod) ?? AccessMethod.PASSCODE_TIMEBOUND;

    // Verifica que existan property y lock (evita FK errors raros)
    const [property, lock] = await Promise.all([
      prisma.property.findUnique({ where: { id: body.propertyId }, select: { id: true } }),
      prisma.lock.findUnique({ where: { id: body.lockId }, select: { id: true } }),
    ]);
    if (!property) return res.status(404).json({ error: "Property not found" });
    if (!lock) return res.status(404).json({ error: "Lock not found" });

    // ✅ C1.3 Token (se genera y se GUARDA)
    const guestToken = crypto.randomUUID();
    const guestTokenExpiresAt = new Date(checkOut.getTime() + 24 * 60 * 60 * 1000);

    // --- Transacción: Reservation + AccessGrant ---
    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.create({
        data: {
          propertyId: body.propertyId,
          guestName: body.guestName,
          guestEmail: body.guestEmail ?? null,
          guestPhone: body.guestPhone ?? null,
          roomName: body.roomName ?? null,
          checkIn,
          checkOut,
          paymentState,

          // ✅ NUEVO
          guestToken,
          guestTokenExpiresAt,
        },
      });

      const accessGrant = await tx.accessGrant.create({
        data: {
          lockId: body.lockId,
          reservationId: reservation.id,
          method,
          status: AccessStatus.PENDING,
          startsAt: checkIn,
          endsAt: checkOut,

          // opcional
          accessCodeMasked: body.accessCodeMasked ?? null,

          // defaults de tu schema
          unlockKey: "#",
        },
      });

      return { reservation, accessGrant };
    });

    return res.status(201).json({
      ok: true,
      reservationId: result.reservation.id,
      accessGrantId: result.accessGrant.id,
      reservation: result.reservation,
      accessGrant: result.accessGrant,
      note:
        "Worker will activate at checkIn window if paymentState=PAID (or if ALLOW_UNPAID=1 in worker env).",
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return res.status(500).json({ error: msg });
  }
}
