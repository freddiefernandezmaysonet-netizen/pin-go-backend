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

    if (!sub?.stripeSubscriptionId || !sub?.stripeSubscriptionItemId) {
      return res.status(400).json({
        ok: false,
        error: "SUBSCRIPTION_NOT_READY",
      });
    }

    const upcoming = await stripe.invoices.retrieveUpcoming({
      customer: sub.stripeCustomerId!,
      subscription: sub.stripeSubscriptionId,
      subscription_items: [
        {
          id: sub.stripeSubscriptionItemId,
          quantity: requestedQuantity,
        },
      ],
    });

    return res.json({
      ok: true,
      amountDue: upcoming.amount_due, // en centavos
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

export default router;