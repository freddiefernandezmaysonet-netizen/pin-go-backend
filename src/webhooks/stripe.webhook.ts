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
import { handleDirectBookingCheckoutCompleted } from "../services/direct-booking.service";
import {
  handleGuestIdentityStripeEvent,
  reconcileGuestIdentityVerificationSession,
} from "../services/guest-identity-webhook.service";
import {
  syncConnectAccountStatusFromWebhook,
} from "../services/stripe-connect.service";

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
          return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
        }

        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } catch (err: any) {
        console.error("❌ Stripe webhook signature error:", err?.message ?? err);
        return res.status(400).send(`Webhook Error: ${err?.message ?? "Invalid signature"}`);
      }

      try {
        // Mantener sync existente de Tuya sin romper nada
        try {
          await syncTuyaEntitlementFromStripeEvent(prisma, event);
        } catch (tuyaErr: any) {
          console.error("⚠️ Tuya webhook sync error:", tuyaErr?.message ?? tuyaErr);
        }

        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;

            console.log("🧾 checkout.session.completed", {
              sessionId: session.id,
              customer: session.customer,
              subscription: session.subscription,
              metadata: session.metadata ?? null,
            });

           const flow = String(session.metadata?.flow ?? "").trim();

           if (flow === "direct_booking") {
             const reservation = await handleDirectBookingCheckoutCompleted(session);

             console.log("✅ direct booking reservation completed", {
               sessionId: session.id,
               reservationId: reservation?.id ?? null,
             });

             break;
           }

            await maybeCompleteSignupOnboarding(session);

            if (session.subscription) {
              await safeSyncBySubscriptionId(String(session.subscription), {
                source: "checkout.session.completed",
                session,
              });
            }

            break;
          }

          case "account.updated": {
            const account =
              event.data.object as Stripe.Account;
            const occurredAt = new Date(
              event.created * 1000
            );
            const payoutStatus =
              await syncConnectAccountStatusFromWebhook(
                account,
                occurredAt
              );

            console.log(
              "[STRIPE_CONNECT_ACCOUNT_STATUS_SYNCED]",
              {
                eventId: event.id,
                accountId: account.id,
                organizationId:
                  payoutStatus?.organizationId ?? null,
                status:
                  payoutStatus?.status ?? null,
                handled: Boolean(payoutStatus),
                livemode: event.livemode,
              }
            );

            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const sub = event.data.object as Stripe.Subscription;

            console.log(`🔄 ${event.type}`, {
              subscriptionId: sub.id,
              customer: sub.customer,
              status: sub.status,
              metadata: sub.metadata ?? null,
            });

            await safeSyncBySubscriptionId(sub.id, {
              source: event.type,
            });

            break;
          }

                    case "identity.verification_session.processing":
          case "identity.verification_session.canceled": {
            const identitySession =
              event.data.object as
                Stripe.Identity.VerificationSession;

            const reservationId = String(
              identitySession.metadata
                ?.reservationId ?? ""
            ).trim();

            if (!reservationId) {
              console.warn(
                "[STRIPE_WEBHOOK] guest identity event skipped",
                {
                  eventId: event.id,
                  eventType: event.type,
                  verificationSessionId:
                    identitySession.id,
                  reason:
                    "RESERVATION_ID_METADATA_MISSING",
                }
              );

              break;
            }

            const identityResult =
              await reconcileGuestIdentityVerificationSession(
                prisma,
                reservationId
              );

            console.log(
              "[STRIPE_WEBHOOK] guest identity state reconciled",
              {
                eventId: event.id,
                eventType: event.type,
                verificationSessionId:
                  identitySession.id,
                reservationNumber:
                  "reservationNumber" in
                  identityResult
                    ? identityResult.reservationNumber
                    : null,
              }
            );

            break;
          }

          case "identity.verification_session.verified":
          case "identity.verification_session.requires_input": {
            const identityResult =
              await handleGuestIdentityStripeEvent(
                prisma,
                event
              );

            console.log(
              "[STRIPE_WEBHOOK] guest identity event processed",
              {
                eventId: event.id,
                eventType: event.type,
                handled: identityResult.handled,
                reservationNumber:
                  "reservationNumber" in identityResult
                    ? identityResult.reservationNumber
                    : null,
              }
            );

            break;
          }

          default: {
            console.log("ℹ️ Stripe event ignored:", event.type);
            break;
          }
        }

        return res.json({
          received: true,
          type: event.type,
        });
      } catch (err: any) {
        console.error("🔥 Stripe webhook processing error:", err?.message ?? err);

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
const flow = String(metadata.flow ?? "").trim();
const pendingSignupId = String(metadata.pendingSignupId ?? "").trim();

const isSignupOnboarding =
  flow === "signup_onboarding" || Boolean(pendingSignupId);

if (!isSignupOnboarding) {
  return;
}
  if (!pendingSignupId) {
    console.warn("⚠️ signup_onboarding without pendingSignupId", {
      sessionId: session.id,
    });
    return;
  }

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
    // Igual actualizamos IDs Stripe por si faltan
    await prisma.pendingSignup.update({
      where: { id: pending.id },
      data: {
        stripeCustomerId: session.customer
          ? String(session.customer)
          : pending.stripeCustomerId,
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
    } else if (session.customer) {
      await tx.organization.update({
        where: { id: organizationId },
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
          organizationId,
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
        completedAt: new Date(),
        organizationId,
        stripeCustomerId: session.customer
          ? String(session.customer)
          : pending.stripeCustomerId,
        stripeSubscriptionId: session.subscription
          ? String(session.subscription)
          : pending.stripeSubscriptionId,
        stripeCheckoutSessionId: session.id,
      },
    });
  });

  console.log("✅ signup onboarding completed", {
    pendingSignupId,
    sessionId: session.id,
    subscriptionId: session.subscription ? String(session.subscription) : null,
  });
}

type SyncContext = {
  source: string;
  session?: Stripe.Checkout.Session;
};

async function safeSyncBySubscriptionId(
  subscriptionId: string,
  context?: SyncContext
) {
  const fullSub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });

  const lockPriceId = String(process.env.STRIPE_PRICE_LOCK_MONTHLY ?? "").trim();
  const smartPriceId = String(process.env.STRIPE_PRICE_SMART_PROPERTY ?? "").trim();

  
  if (!lockPriceId) {
    throw new Error("Missing STRIPE_PRICE_LOCK_MONTHLY");
  }

  
  let organizationId =
    typeof fullSub.metadata?.organizationId === "string" &&
    fullSub.metadata.organizationId.trim()
      ? fullSub.metadata.organizationId.trim()
      : null;

  // fallback 1: subscription ya persistida
  if (!organizationId) {
    const existingSub = await prisma.subscription.findFirst({
      where: {
        OR: [
          { stripeSubscriptionId: fullSub.id },
          { stripeCustomerId: String(fullSub.customer) },
        ],
      },
      select: { organizationId: true },
    });

    organizationId = existingSub?.organizationId ?? null;
  }

  // fallback 2: organization con mismo stripeCustomerId
  if (!organizationId) {
    const org = await prisma.organization.findFirst({
      where: { stripeCustomerId: String(fullSub.customer) },
      select: { id: true },
    });

    organizationId = org?.id ?? null;
  }

  // fallback 3: pending signup por stripeSubscriptionId
  if (!organizationId) {
    const pendingBySub = await prisma.pendingSignup.findFirst({
      where: { stripeSubscriptionId: fullSub.id },
      select: { organizationId: true },
    });

    organizationId = pendingBySub?.organizationId ?? null;
  }

  // fallback 4: pending signup por stripeCustomerId
  if (!organizationId) {
    const pendingByCustomer = await prisma.pendingSignup.findFirst({
      where: { stripeCustomerId: String(fullSub.customer) },
      select: { organizationId: true },
    });

    organizationId = pendingByCustomer?.organizationId ?? null;
  }

  // fallback 5: checkout session metadata si vino desde checkout.session.completed
  if (!organizationId && context?.session?.metadata) {
    const sessionOrgId = String(context.session.metadata.organizationId ?? "").trim();
    if (sessionOrgId) {
      organizationId = sessionOrgId;
    }
  }

  if (!organizationId && context?.session?.metadata?.pendingSignupId) {
    const pending = await prisma.pendingSignup.findUnique({
      where: { id: String(context.session.metadata.pendingSignupId) },
      select: { organizationId: true },
    });

    organizationId = pending?.organizationId ?? null;
  }

  if (!organizationId) {
    console.error("❌ safeSyncBySubscriptionId could not resolve organizationId", {
      source: context?.source ?? "unknown",
      subscriptionId: fullSub.id,
      customerId: String(fullSub.customer),
      metadata: fullSub.metadata ?? null,
    });
    throw new Error("STRIPE_SYNC_ORGANIZATION_NOT_RESOLVED");
  }

  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
  });

const items = fullSub.items.data;

const lockItem =
  items.find((i) => i.price?.id === lockPriceId) ?? null;

const smartItem =
  smartPriceId
    ? items.find((i) => i.price?.id === smartPriceId) ?? null
    : null;

const HAAS_LOCK_PRICE_IDS = [
  process.env.STRIPE_PRICE_HAAS_ESSENTIAL_LOCK_MONTHLY,
  process.env.STRIPE_PRICE_HAAS_PRO_LOCK_MONTHLY,
  process.env.STRIPE_PRICE_HAAS_ELITE_LOCK_MONTHLY,
]
  .map((v) => String(v ?? "").trim())
  .filter(Boolean);

const HAAS_SMART_PRICE_IDS = [
  process.env.STRIPE_PRICE_HAAS_SMART_1_MONTHLY,
  process.env.STRIPE_PRICE_HAAS_SMART_2_MONTHLY,
]
  .map((v) => String(v ?? "").trim())
  .filter(Boolean);

let lockQty = Number(lockItem?.quantity ?? 0);
let smartQty = Number(smartItem?.quantity ?? 0);

for (const item of items) {
  const priceId = String(item.price?.id ?? "").trim();

 
  if (HAAS_LOCK_PRICE_IDS.includes(priceId)) {
    lockQty += Number(item.quantity ?? 1);
  }

  if (HAAS_SMART_PRICE_IDS.includes(priceId)) {
    smartQty += Number(item.quantity ?? 1);
  }
}
 
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

  const entitledLocks =
    status === "ACTIVE" || status === "TRIALING"
      ? Math.max(lockQty, activeLocks)
      : activeLocks;

  const entitledSmartProperties =
    status === "ACTIVE" || status === "TRIALING" ? smartQty : 0;

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

  console.log("✅ Stripe subscription synced", {
    source: context?.source ?? "unknown",
    organizationId,
    subscriptionId: fullSub.id,
    lockItemId: lockItem?.id ?? null,
    smartItemId: smartItem?.id ?? null,
    entitledLocks,
    entitledSmartProperties,
    status,
  });
}
