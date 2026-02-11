import type { Express, Request, Response } from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import stripe from "../billing/stripe";
import { sendGuestAccessLinkSms } from "../services/guestLinkSms.service";

export function registerStripeWebhook(app: Express, prisma: PrismaClient) {
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  // IMPORTANTE: raw antes de express.json (por eso esto se registra antes en server.ts)
  app.post(
    "/webhooks/stripe",
    bodyParser.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"] as string | undefined;

      try {
        if (!sig) return res.status(400).send("Missing Stripe-Signature header");
        if (!STRIPE_WEBHOOK_SECRET) {
          return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET in .env");
        }

        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
        } catch (err: any) {
          return res.status(400).send(`Webhook Error: ${err?.message ?? "Invalid signature"}`);
        }

        // =====================
        // Dedup (idempotencia)
        // =====================
        const stripeId = event.id;
        const existing = await prisma.stripeEventLog.findUnique({ where: { stripeId } });

        if (existing?.processedAt) {
          return res.json({ received: true, deduped: true, type: event.type });
        }

        if (!existing) {
          await prisma.stripeEventLog.create({
            data: {
              stripeId,
              type: event.type,
              livemode: event.livemode,
              payload: event as any,
            },
          });
        }

        // =====================
        // Procesamiento
        // =====================
       
     try {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as any;

      // ✅ Pago one-time por reserva (mode=payment)
      if (session.mode === "payment") {
        const reservationId = session?.metadata?.reservationId as string | undefined;

        let reservation = reservationId
          ? await prisma.reservation.findUnique({ where: { id: reservationId } })
          : null;

        if (!reservation) {
          reservation = await prisma.reservation.findFirst({
            where: { stripeCheckoutSessionId: session.id },
          });
        }

        if (reservation) {
          await prisma.reservation.update({
            where: { id: reservation.id },
            data: {
              paymentState: "PAID",
              stripeCheckoutSessionId: session.id,
              stripePaymentIntentId: session.payment_intent ?? null,
            } as any,
          });

          if (process.env.GUEST_LINK_SMS_ON_PAID === "1") {
            await sendGuestAccessLinkSms(prisma, reservation.id, "PAID");
          }
        }
      }

      // ✅ Si fue checkout de suscripción: sincroniza inmediatamente
      if (session.mode === "subscription" && session.subscription) {
        const stripeSub = await stripe.subscriptions.retrieve(String(session.subscription));
        await syncSubscriptionToDb(prisma, stripeSub as any);
      }

      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionToDb(prisma, sub);
      break;
    }

    default: {
      break;
    }
  }

  // ✅ Log seguro (sin usar "sub" fuera de scope)
  const obj: any = event.data?.object;
  console.log("[stripe webhook]", event.type, "id:", obj?.id);

  await prisma.stripeEventLog.update({
    where: { stripeId },
    data: { processedAt: new Date(), error: null },
  });

  return res.json({ received: true, type: event.type });
} catch (err: any) {
  await prisma.stripeEventLog.update({
    where: { stripeId },
    data: { processedAt: new Date(), error: err?.message ?? String(err) },
  });

  return res.status(500).json({ error: err?.message ?? "Webhook processing failed" });
}

      
      } catch (e: any) {
        return res.status(500).json({ error: e?.message ?? "Webhook handler failed" });
      }
    }
  );
}

async function syncSubscriptionToDb(prisma: PrismaClient, sub: Stripe.Subscription) {
  const lockPriceId = process.env.STRIPE_PRICE_LOCK_MONTHLY;
  if (!lockPriceId) {
    console.warn("[stripe sync] missing STRIPE_PRICE_LOCK_MONTHLY");
    return;
  }

  // 🔥 siempre refrescar desde Stripe (con prices expandidos)
  const fullSub = await stripe.subscriptions.retrieve(sub.id, {
    expand: ["items.data.price"],
  });

  // 1) Resolver organizationId
  let organizationId = (fullSub.metadata?.organizationId as string | undefined) ?? null;

  if (!organizationId) {
    const found = await prisma.subscription.findFirst({
      where: { stripeCustomerId: String(fullSub.customer) },
      select: { organizationId: true },
    });
    organizationId = found?.organizationId ?? null;
  }

  if (!organizationId) {
    console.warn("[stripe sync] missing organizationId for sub:", fullSub.id);
    return;
  }

  // 2) Item correcto por price id (locks)
  const item =
    fullSub.items.data.find((i) => (i.price as any)?.id === lockPriceId) ?? fullSub.items.data[0];

  const quantity = item?.quantity ?? 0;

  // 3) Mapear status Stripe -> tu enum
  const stripeStatus = fullSub.status;
  const status =
    stripeStatus === "active"
      ? "ACTIVE"
      : stripeStatus === "trialing"
      ? "TRIALING"
      : stripeStatus === "past_due"
      ? "PAST_DUE"
      : stripeStatus === "canceled"
      ? "CANCELED"
      : stripeStatus === "unpaid"
      ? "UNPAID"
      : stripeStatus === "incomplete"
      ? "INCOMPLETE"
      : stripeStatus === "incomplete_expired"
      ? "INCOMPLETE_EXPIRED"
      : "INCOMPLETE";

  // 4) Entitlement
  const entitledLocks = status === "ACTIVE" || status === "TRIALING" ? quantity : 0;

  await prisma.subscription.upsert({
    where: { organizationId },
    create: {
      organizationId,
      stripeCustomerId: String(fullSub.customer),
      stripeSubscriptionId: fullSub.id,
      stripeSubscriptionItemId: item?.id ?? null,
      status: status as any,
      entitledLocks,
      currentPeriodStart: fullSub.current_period_start
        ? new Date(fullSub.current_period_start * 1000)
        : null,
      currentPeriodEnd: fullSub.current_period_end
        ? new Date(fullSub.current_period_end * 1000)
        : null,
    } as any,
    update: {
      stripeCustomerId: String(fullSub.customer),
      stripeSubscriptionId: fullSub.id,
      stripeSubscriptionItemId: item?.id ?? null,
      status: status as any,
      entitledLocks,
      currentPeriodStart: fullSub.current_period_start
        ? new Date(fullSub.current_period_start * 1000)
        : null,
      currentPeriodEnd: fullSub.current_period_end
        ? new Date(fullSub.current_period_end * 1000)
        : null,
    } as any,
  });
}
