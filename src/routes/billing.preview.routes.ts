import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import stripe from "../billing/stripe";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();
const prisma = new PrismaClient();

router.post("/locks/preview", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const orgId = String(user?.orgId ?? "").trim();

    const requestedQuantity = Number(req.body?.quantity);

    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUANTITY",
      });
    }

    const sub = await prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripeSubscriptionItemId: true,
      },
    });

    if (
      !sub?.stripeSubscriptionId ||
      !sub?.stripeCustomerId ||
      !sub?.stripeSubscriptionItemId
    ) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_NOT_READY",
      });
    }

    const fullSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

    const lockItem = fullSub.items.data.find(
      (item: any) => item.id === sub.stripeSubscriptionItemId
    );

    if (!lockItem) {
      return res.status(400).json({
        ok: false,
        error: "LOCK_SUBSCRIPTION_ITEM_NOT_FOUND",
      });
    }

    const subscriptionItems = fullSub.items.data.map((item: any) => ({
      id: item.id,
      quantity:
        item.id === sub.stripeSubscriptionItemId
          ? requestedQuantity
          : Number(item.quantity ?? 0),
    }));

    const upcoming = await stripe.invoices.retrieveUpcoming({
      customer: sub.stripeCustomerId,
      subscription: sub.stripeSubscriptionId,
      subscription_items: subscriptionItems,
    });

    return res.json({
      ok: true,
      amountDue: upcoming.amount_due,
      currency: upcoming.currency,
      nextTotal: upcoming.total,
      lines: upcoming.lines.data.map((l) => ({
        description: l.description,
        amount: l.amount,
      })),
    });
  } catch (e: any) {
    console.error("billing preview error", e);
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

router.post("/smart/preview", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const orgId = String(user?.orgId ?? "").trim();

    const requestedQuantity = Number(req.body?.quantity);

    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUANTITY",
      });
    }

    const sub = await prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripeSmartSubscriptionItemId: true,
      },
    });

    if (
      !sub?.stripeSubscriptionId ||
      !sub?.stripeCustomerId ||
      !sub?.stripeSmartSubscriptionItemId
    ) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_NOT_READY",
      });
    }

    const fullSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

    const smartItem = fullSub.items.data.find(
      (item: any) => item.id === sub.stripeSmartSubscriptionItemId
    );

    if (!smartItem) {
      return res.status(400).json({
        ok: false,
        error: "SMART_SUBSCRIPTION_ITEM_NOT_FOUND",
      });
    }

    const subscriptionItems = fullSub.items.data.map((item: any) => ({
      id: item.id,
      quantity:
        item.id === sub.stripeSmartSubscriptionItemId
          ? requestedQuantity
          : Number(item.quantity ?? 0),
    }));

    const upcoming = await stripe.invoices.retrieveUpcoming({
      customer: sub.stripeCustomerId,
      subscription: sub.stripeSubscriptionId,
      subscription_items: subscriptionItems,
    });

    return res.json({
      ok: true,
      amountDue: upcoming.amount_due,
      currency: upcoming.currency,
      nextTotal: upcoming.total,
      lines: upcoming.lines.data.map((l) => ({
        description: l.description,
        amount: l.amount,
      })),
    });
  } catch (e: any) {
    console.error("billing smart preview error", e);
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

export default router;