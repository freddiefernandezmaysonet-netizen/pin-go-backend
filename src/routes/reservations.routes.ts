// src/routes/reservations.routes.ts
import { Router } from 'express';
import { PrismaClient, PaymentState } from '@prisma/client';

import stripe from '../billing/stripe';

import { createReservationHandler } from '../services/reservations.service';
import { getReservationByIdHandler } from '../services/reservations.get.service';
import { patchReservationHandler } from '../services/reservations.patch.service';
import { getReservationAccessHandler } from '../services/reservations.access.get.service';

const prisma = new PrismaClient();
export const reservationsRouter = Router();

// ========= EXISTENTES =========
reservationsRouter.post('/', createReservationHandler);
reservationsRouter.get('/:id/access', getReservationAccessHandler);
reservationsRouter.get('/:id', getReservationByIdHandler);
reservationsRouter.patch('/:id', patchReservationHandler);

// ========= NUEVO: PAGO POR RESERVA =========
// POST /reservations/:id/pay  -> retorna checkoutUrl
reservationsRouter.post('/:id/pay', async (req, res) => {
  try {
    const id = String(req.params.id);

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: { property: true },
    });

    if (!reservation) {
      return res.status(404).json({ ok: false, error: 'Reservation not found' });
    }

    if (reservation.paymentState === PaymentState.PAID) {
      return res.json({ ok: true, alreadyPaid: true });
    }

    const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Pin&Go Access - ${reservation.property?.name ?? 'Property'}`,
              description: `Reservation ${reservation.id}`,
            },
            unit_amount: 3999, // $39.99 (ajusta luego)
          },
          quantity: 1,
        },
      ],
      success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/billing/cancel`,
      metadata: {
        reservationId: reservation.id,
      },
    });

    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { stripeCheckoutSessionId: session.id },
    });

    return res.json({
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (e: any) {
    const stripeMsg =
      e?.raw?.message ||
      e?.message ||
      JSON.stringify(e, Object.getOwnPropertyNames(e));

    console.error('reservation pay error FULL:', stripeMsg);

    return res.status(500).json({
      ok: false,
      error: stripeMsg,
    });
  }
});
