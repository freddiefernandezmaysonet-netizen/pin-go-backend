import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function getReservationAccessHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        property: true,
        accessGrants: {
          orderBy: { createdAt: 'desc' },
          include: { lock: true },
        },
      },
    });

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reservation not found' });
    }

    const grants = reservation.accessGrants.map((g) => ({
      id: g.id,
      method: g.method,
      status: g.status,
      startsAt: g.startsAt,
      endsAt: g.endsAt,
      accessCodeMasked: g.accessCodeMasked,
      unlockKey: g.unlockKey,
      ttlockKeyboardPwdId: g.ttlockKeyboardPwdId,
      lock: g.lock
        ? { id: g.lock.id, ttlockLockId: g.lock.ttlockLockId, name: (g.lock as any).name ?? null }
        : null,
      lastError: g.lastError,
      updatedAt: g.updatedAt,
    }));

    return res.json({
      ok: true,
      reservation: {
        id: reservation.id,
        guestName: reservation.guestName,
        guestEmail: reservation.guestEmail,
        guestPhone: reservation.guestPhone,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        paymentState: reservation.paymentState,
        property: reservation.property,
      },
      grants,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
}
