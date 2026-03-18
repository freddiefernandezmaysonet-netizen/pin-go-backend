import { Router } from "express";
import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import stripe from "../billing/stripe"; // tu instancia ya configurada

const router = Router();
const prisma = new PrismaClient();

/**
 * Admin key middleware
 * Header: x-admin-key: <ADMIN_KEY>
 */
router.use((req, res, next) => {
  const key = req.header("x-admin-key");
  const expected = process.env.ADMIN_KEY;

  if (!expected) return res.status(500).json({ ok: false, error: "ADMIN_KEY not configured" });
  if (!key || key !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
});

function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  return stripeStatus === "active"
    ? SubscriptionStatus.ACTIVE
    : stripeStatus === "trialing"
    ? SubscriptionStatus.TRIALING
    : stripeStatus === "past_due"
    ? SubscriptionStatus.PAST_DUE
    : stripeStatus === "canceled"
    ? SubscriptionStatus.CANCELED
    : stripeStatus === "unpaid"
    ? SubscriptionStatus.UNPAID
    : stripeStatus === "incomplete"
    ? SubscriptionStatus.INCOMPLETE
    : stripeStatus === "incomplete_expired"
    ? SubscriptionStatus.INCOMPLETE_EXPIRED
    : SubscriptionStatus.INCOMPLETE;
}

/**
 * POST /api/admin/subscription/sync
 * Body: { organizationId } OR { stripeSubscriptionId }
 *
 * - Refresca la suscripción desde Stripe (expand items.price)
 * - Calcula entitledLocks usando quantity del price STRIPE_PRICE_LOCK_MONTHLY
 * - Upsert en Prisma Subscription
 */
router.post("/subscription/sync", async (req, res) => {
  try {
    const { organizationId, stripeSubscriptionId } = req.body ?? {};

    if (!organizationId && !stripeSubscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing organizationId or stripeSubscriptionId",
      });
    }

    // 1) Resolver stripeSubscriptionId si no vino
    
      let subId = String(stripeSubscriptionId ?? "").trim() || null;

      let row:
        | {
            stripeSubscriptionId: string | null;
            stripeCustomerId: string | null;
          }
        | null = null;

      if (!subId && organizationId) {
        row = await prisma.subscription.findUnique({
          where: { organizationId: String(organizationId) },
          select: {
            stripeSubscriptionId: true,
            stripeCustomerId: true,
         },
       });

       subId = row?.stripeSubscriptionId ?? null;
     }

     if (!subId && row?.stripeCustomerId) {
       const subs = await stripe.subscriptions.list({
         customer: row.stripeCustomerId,
         status: "all",
         limit: 10,
       });

       const preferred =
         subs.data.find((s) => s.status === "active") ??
         subs.data.find((s) => s.status === "trialing") ??
         subs.data[0];

      subId = preferred?.id ?? null;
    }

    if (!subId) {
      return res.status(404).json({
        ok: false,
        error: "No stripeSubscriptionId found for organization or customer",
      });
    }

    // 2) Traer subscription FULL desde Stripe
    const fullSub = await stripe.subscriptions.retrieve(subId, {
      expand: ["items.data.price"],
    });

    // 3) Resolver orgId (preferimos metadata)
    let orgId =
      (fullSub.metadata?.organizationId as string | undefined) ??
      (organizationId ? String(organizationId) : null);

    // Fallback si aún no hay orgId: buscar por stripeCustomerId
    if (!orgId) {
      const found = await prisma.subscription.findFirst({
        where: { stripeCustomerId: String(fullSub.customer) },
        select: { organizationId: true },
      });
      orgId = found?.organizationId ?? null;
    }

    if (!orgId) {
      return res.status(409).json({
        ok: false,
        error: "Cannot resolve organizationId for subscription",
      });
    }

    // 4) Encontrar el item correcto por price id (locks)
    const lockPriceId = process.env.STRIPE_PRICE_LOCK_MONTHLY;
    const items = fullSub.items?.data ?? [];

    const item =
      (lockPriceId
        ? items.find((i: any) => i?.price?.id === lockPriceId)
        : null) ?? items[0];

    const quantity = Number(item?.quantity ?? 0);

    // 5) Mapear status + entitlement
    const status = mapStripeStatus(String(fullSub.status));
    const entitledLocks =
      status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIALING
        ? quantity
        : 0;

    const currentPeriodStart = fullSub.current_period_start
      ? new Date(fullSub.current_period_start * 1000)
      : null;

    const currentPeriodEnd = fullSub.current_period_end
      ? new Date(fullSub.current_period_end * 1000)
      : null;

    // 6) Upsert a DB
    const saved = await prisma.subscription.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        stripeCustomerId: String(fullSub.customer),
        stripeSubscriptionId: fullSub.id,
        stripeSubscriptionItemId: item?.id ?? null,
        status,
        entitledLocks,
        currentPeriodStart,
        currentPeriodEnd,
      },
      update: {
        stripeCustomerId: String(fullSub.customer),
        stripeSubscriptionId: fullSub.id,
        stripeSubscriptionItemId: item?.id ?? null,
        status,
        entitledLocks,
        currentPeriodStart,
        currentPeriodEnd,
      },
    });

    return res.json({
      ok: true,
      organizationId: orgId,
      stripeSubscriptionId: fullSub.id,
      stripeStatus: fullSub.status,
      mappedStatus: status,
      lockPriceId: lockPriceId ?? null,
      quantity,
      entitledLocks,
      currentPeriodStart,
      currentPeriodEnd,
      saved,
    });
  } catch (e: any) {
    console.error("admin/subscription/sync error:", e?.message ?? e);
    return res.status(500).json({ ok: false, error: e?.message ?? "sync failed" });
  }
});

export default router;
