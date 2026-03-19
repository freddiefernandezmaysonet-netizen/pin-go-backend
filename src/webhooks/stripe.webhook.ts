import type { Express, Request, Response } from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import {
  PrismaClient,
  DashboardUserRole,
  PendingSignupStatus,
} from "@prisma/client";
import stripe from "../billing/stripe";

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
        if (!sig) {
          return res.status(400).send("Missing Stripe-Signature header");
        }

        if (!endpointSecret) {
          return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET in .env");
        }

        console.log(">>> WEBHOOK HIT");
        console.log(">>> has-signature:", !!sig);
        console.log(">>> body-is-buffer:", Buffer.isBuffer(req.body));
        console.log(">>> body-length:", (req.body as Buffer)?.length ?? 0);

        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } catch (err: any) {
        console.error("❌ Webhook signature error:", err?.message ?? err);
        return res.status(400).send(`Webhook Error: ${err?.message ?? "Invalid signature"}`);
      }

      console.log(`📩 Stripe event received: ${event.type}`);

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;

            console.log("🧾 checkout.session.completed", {
              sessionId: session.id,
              customer: session.customer,
              subscription: session.subscription,
              metadata: session.metadata,
            });

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

            console.log("🔄 subscription event", {
              id: sub.id,
              status: sub.status,
              customer: sub.customer,
              metadata: sub.metadata,
            });

            await safeSyncBySubscriptionId(sub.id);
            break;
          }

          default: {
            console.log("ℹ️ unhandled event:", event.type);
            break;
          }
        }

        return res.json({ received: true, type: event.type });
      } catch (err: any) {
        console.error("🔥 webhook processing error:", err?.message ?? err);

        return res.status(500).json({
          ok: false,
          error: err?.message ?? "webhook failed",
        });
      }
    }
  );
}

async function maybeCompleteSignupOnboarding(session: Stripe.Checkout.Session) {
  const metadata = session.metadata ?? {};
  const flow = String(metadata.flow ?? "");

  if (flow !== "signup_onboarding") {
    return;
  }

  const pendingSignupId = String(metadata.pendingSignupId ?? "").trim();

  if (!pendingSignupId) {
    console.warn("⚠️ signup onboarding session missing pendingSignupId", {
      sessionId: session.id,
    });
    return;
  }

  console.log("🚀 onboarding webhook start", {
    sessionId: session.id,
    pendingSignupId,
    customer: session.customer,
    subscription: session.subscription,
  });

  const pending = await prisma.pendingSignup.findUnique({
    where: { id: pendingSignupId },
  });

  if (!pending) {
    console.warn("⚠️ PendingSignup not found", {
      pendingSignupId,
      sessionId: session.id,
    });
    return;
  }

  if (pending.status === PendingSignupStatus.COMPLETED && pending.organizationId) {
    console.log("✅ onboarding already completed, skipping", {
      pendingSignupId,
      organizationId: pending.organizationId,
    });
    return;
  }

  const existingUser = await prisma.dashboardUser.findUnique({
    where: { email: pending.email },
    select: {
      id: true,
      organizationId: true,
    },
  });

  if (existingUser) {
    console.warn("⚠️ DashboardUser already exists for pending signup email", {
      pendingSignupId,
      email: pending.email,
      userId: existingUser.id,
    });

    await prisma.pendingSignup.update({
      where: { id: pending.id },
      data: {
        status: PendingSignupStatus.COMPLETED,
        completedAt: new Date(),
        organizationId: existingUser.organizationId,
        stripeCustomerId: session.customer ? String(session.customer) : pending.stripeCustomerId,
        stripeSubscriptionId: session.subscription
          ? String(session.subscription)
          : pending.stripeSubscriptionId,
      },
    });

    return;
  }

  await prisma.$transaction(async (tx) => {
    let organizationId = pending.organizationId ?? null;

    if (!organizationId) {
      const org = await tx.organization.create({
        data: {
          name: pending.organizationName,
          stripeCustomerId: session.customer ? String(session.customer) : pending.stripeCustomerId,
        },
        select: { id: true },
      });

      organizationId = org.id;
    }

    await tx.dashboardUser.create({
      data: {
        organizationId,
        email: pending.email,
        passwordHash: pending.passwordHash,
        fullName: pending.fullName,
        role: DashboardUserRole.ADMIN,
        isActive: true,
      },
    });

    await tx.pendingSignup.update({
      where: { id: pending.id },
      data: {
        status: PendingSignupStatus.COMPLETED,
        completedAt: new Date(),
        organizationId,
        stripeCustomerId: session.customer ? String(session.customer) : pending.stripeCustomerId,
        stripeSubscriptionId: session.subscription
          ? String(session.subscription)
          : pending.stripeSubscriptionId,
        stripeCheckoutSessionId: session.id,
      },
    });
  });

  console.log("✅ onboarding webhook completed", {
    pendingSignupId,
    sessionId: session.id,
  });
}

async function safeSyncBySubscriptionId(subscriptionId: string) {
  try {
    console.log("🚀 sync start:", subscriptionId);

    const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });

    let organizationId =
      (fullSub.metadata?.organizationId as string | undefined) ?? null;

    if (!organizationId) {
      console.warn("⚠️ No orgId in metadata, fallback by customer");

      const found = await prisma.subscription.findFirst({
        where: {
          stripeCustomerId: String(fullSub.customer),
        },
        select: {
          organizationId: true,
        },
      });

      organizationId = found?.organizationId ?? null;
    }

    if (!organizationId) {
      const foundOrg = await prisma.organization.findFirst({
        where: {
          stripeCustomerId: String(fullSub.customer),
        },
        select: {
          id: true,
        },
      });

      organizationId = foundOrg?.id ?? null;
    }

    if (!organizationId) {
      const foundPending = await prisma.pendingSignup.findFirst({
        where: {
          stripeSubscriptionId: fullSub.id,
        },
        select: {
          organizationId: true,
        },
      });

      organizationId = foundPending?.organizationId ?? null;
    }

    if (!organizationId) {
      console.error("❌ Cannot resolve organizationId for sub:", subscriptionId);
      return;
    }

    const lockPriceId = process.env.STRIPE_PRICE_LOCK_MONTHLY;
    const items = fullSub.items?.data ?? [];

    const item =
      (lockPriceId
        ? items.find((i: any) => i?.price?.id === lockPriceId)
        : null) ?? items[0];

    const quantity = Number(item?.quantity ?? 0);

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
    property: {
      organizationId,
    },
  },
});

const stripeEntitledLocks =
  status === "ACTIVE" || status === "TRIALING" ? quantity : 0;

// Blindaje: nunca persistir entitledLocks por debajo de activeLocks
const entitledLocks =
  status === "ACTIVE" || status === "TRIALING"
    ? Math.max(stripeEntitledLocks, activeLocks)
    : 0;

const belowActiveLocks =
  (status === "ACTIVE" || status === "TRIALING") &&
  stripeEntitledLocks < activeLocks;

if (belowActiveLocks) {
  console.error("❌ Stripe quantity below active locks detected", {
    organizationId,
    stripeSubscriptionId: fullSub.id,
    stripeQuantity: quantity,
    stripeEntitledLocks,
    activeLocks,
    persistedEntitledLocks: entitledLocks,
  });
}

console.log("📊 sync computed", {
  organizationId,
  stripeSubscriptionId: fullSub.id,
  quantity,
  stripeEntitledLocks,
  activeLocks,
  entitledLocks,
  status,
});
    
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
      },
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
      },
    });

    console.log("✅ sync success:", subscriptionId);
  } catch (err: any) {
    console.error("🔥 sync error:", err?.message ?? err);
  }
}