import type { Express, Request, Response } from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import {
  PrismaClient,
  DashboardUserRole,
  PendingSignupStatus,
} from "@prisma/client";
import stripe from "../billing/stripe";
import syncTuyaEntitlementFromStripeEvent from "../billing/stripe/stripe.tuya.entitlement";

const prisma = new PrismaClient();

export function registerStripeWebhook(app: Express) {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  app.post(
    "/webhooks/stripe",
    bodyParser.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"] as string | undefined;

      let event: Stripe.Event;

      try {
        if (!sig) return res.status(400).send("Missing Stripe-Signature header");
        if (!endpointSecret) {
          return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
        }

        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } catch (err: any) {
        return res.status(400).send(`Webhook Error: ${err?.message}`);
      }

      try {
        await syncTuyaEntitlementFromStripeEvent(prisma, event);

        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;

            await maybeCompleteSignupOnboarding(session);

            if (session.subscription) {
              await safeSyncBySubscriptionId(String(session.subscription));
            }
            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const sub = event.data.object as Stripe.Subscription;
            await safeSyncBySubscriptionId(sub.id);
            break;
          }
        }

        return res.json({ received: true });
      } catch (err: any) {
        console.error("[stripe webhook] error", err);
        return res.status(500).json({ ok: false, error: err?.message });
      }
    }
  );
}

/* ===========================
   ONBOARDING
=========================== */
async function maybeCompleteSignupOnboarding(session: Stripe.Checkout.Session) {
  const metadata = session.metadata ?? {};
  if (metadata.flow !== "signup_onboarding") return;

  const pending = await prisma.pendingSignup.findUnique({
    where: { id: String(metadata.pendingSignupId) },
  });

  if (!pending) return;

  // Si ya está COMPLETED, igual asegúrate de dejar la org enlazada al customer.
  if (pending.status === PendingSignupStatus.COMPLETED) {
    if (pending.organizationId && session.customer) {
      await prisma.organization.update({
        where: { id: pending.organizationId },
        data: { stripeCustomerId: String(session.customer) },
      }).catch(() => null);
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    let orgId = pending.organizationId ?? null;

    if (!orgId) {
      const createdOrg = await tx.organization.create({
        data: {
          name: pending.organizationName,
          stripeCustomerId: String(session.customer),
        },
      });
      orgId = createdOrg.id;
    } else {
      // 🔥 FIX: si la organización ya existía, igual enlázala al customer de Stripe
      await tx.organization.update({
        where: { id: orgId },
        data: {
          stripeCustomerId: String(session.customer),
        },
      });
    }

    const existingUser = await tx.dashboardUser.findUnique({
      where: { email: pending.email },
      select: { id: true },
    });

    if (!existingUser) {
      await tx.dashboardUser.create({
        data: {
          organizationId: orgId,
          email: pending.email,
          passwordHash: pending.passwordHash,
          fullName: pending.fullName,
          role: DashboardUserRole.ADMIN,
          isActive: true,
        },
      });
    }

    await tx.pendingSignup.update({
      where: { id: pending.id },
      data: {
        status: PendingSignupStatus.COMPLETED,
        organizationId: orgId,
        stripeCustomerId: String(session.customer),
        stripeSubscriptionId: session.subscription
          ? String(session.subscription)
          : null,
      },
    });
  });
}

/* ===========================
   CORE SYNC
=========================== */
async function safeSyncBySubscriptionId(subscriptionId: string) {
  try {
    const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });

    let organizationId =
      (fullSub.metadata?.organizationId as string) ?? null;

    if (!organizationId) {
      const existingSub = await prisma.subscription.findFirst({
        where: { stripeCustomerId: String(fullSub.customer) },
        select: { organizationId: true },
      });
      organizationId = existingSub?.organizationId ?? null;
    }

    if (!organizationId) {
      const org = await prisma.organization.findFirst({
        where: { stripeCustomerId: String(fullSub.customer) },
        select: { id: true },
      });
      organizationId = org?.id ?? null;
    }

    // 🔥 FIX: fallback a PendingSignup cuando aún no existe Subscription
    if (!organizationId) {
      const pendingBySub = await prisma.pendingSignup.findFirst({
        where: { stripeSubscriptionId: fullSub.id },
        select: { organizationId: true },
      });
      organizationId = pendingBySub?.organizationId ?? null;
    }

    if (!organizationId) {
      const pendingByCustomer = await prisma.pendingSignup.findFirst({
        where: { stripeCustomerId: String(fullSub.customer) },
        select: { organizationId: true },
      });
      organizationId = pendingByCustomer?.organizationId ?? null;
    }

    if (!organizationId) {
      console.warn("[stripe webhook] organizationId not found for subscription", {
        subscriptionId: fullSub.id,
        customer: String(fullSub.customer),
      });
      return;
    }

    const existing = await prisma.subscription.findUnique({
      where: { organizationId },
    });

    const lockPriceId = process.env.STRIPE_PRICE_LOCK_MONTHLY!;
    const smartPriceId = process.env.STRIPE_PRICE_SMART_PROPERTY!;

    const items = fullSub.items.data;

    const lockItem = items.find((i) => i.price.id === lockPriceId);
    const smartItem = items.find((i) => i.price.id === smartPriceId);

    const quantity = lockItem?.quantity ?? 0;
    const smartQuantity = smartItem?.quantity ?? 0;

    const status =
      fullSub.status === "active"
        ? "ACTIVE"
        : fullSub.status === "trialing"
        ? "TRIALING"
        : fullSub.status === "past_due"
        ? "PAST_DUE"
        : fullSub.status === "canceled"
        ? "CANCELED"
        : fullSub.status === "unpaid"
        ? "UNPAID"
        : fullSub.status === "incomplete"
        ? "INCOMPLETE"
        : fullSub.status === "incomplete_expired"
        ? "INCOMPLETE_EXPIRED"
        : "INCOMPLETE";

    const activeLocks = await prisma.lock.count({
      where: {
        isActive: true,
        property: { organizationId },
      },
    });

    const stripeEntitledLocks =
      status === "ACTIVE" || status === "TRIALING" ? quantity : 0;

    const entitledLocks = Math.max(stripeEntitledLocks, activeLocks);

    const stripeEntitledSmartProperties =
      status === "ACTIVE" || status === "TRIALING" ? smartQuantity : 0;

    const entitledSmartProperties = stripeEntitledSmartProperties;

    await prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        stripeCustomerId: String(fullSub.customer),
        stripeSubscriptionId: fullSub.id,
        stripeSubscriptionItemId:
          lockItem?.id ?? existing?.stripeSubscriptionItemId ?? null,
        stripeSmartSubscriptionItemId:
          smartItem?.id ?? existing?.stripeSmartSubscriptionItemId ?? null,
        status: status as any,
        entitledLocks,
        entitledSmartProperties,
        currentPeriodStart: fullSub.current_period_start
          ? new Date(fullSub.current_period_start * 1000)
          : null,
        currentPeriodEnd: fullSub.current_period_end
          ? new Date(fullSub.current_period_end * 1000)
          : null,
      },
      update: {
        stripeCustomerId: String(fullSub.customer),
        stripeSubscriptionId: fullSub.id,
        stripeSubscriptionItemId:
          lockItem?.id ?? existing?.stripeSubscriptionItemId ?? null,
        stripeSmartSubscriptionItemId:
          smartItem?.id ?? existing?.stripeSmartSubscriptionItemId ?? null,
        status: status as any,
        entitledLocks,
        entitledSmartProperties,
        currentPeriodStart: fullSub.current_period_start
          ? new Date(fullSub.current_period_start * 1000)
          : null,
        currentPeriodEnd: fullSub.current_period_end
          ? new Date(fullSub.current_period_end * 1000)
          : null,
      },
    });
  } catch (err: any) {
    console.error("🔥 sync error:", err?.message ?? err);
  }
}