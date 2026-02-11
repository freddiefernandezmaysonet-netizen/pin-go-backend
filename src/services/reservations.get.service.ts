// src/services/reservations.get.service.ts
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export async function getReservationByIdHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        property: true,
        accessGrants: {
          orderBy: { createdAt: 'desc' },
          include: {
            lock: true,
            person: true,
            messages: { select: { id: true } },
          },
        },
      },
    });

    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

    return res.json({ ok: true, reservation });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
}
