import express from "express";
import stripe from "../billing/stripe";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

export function buildBillingPortalRouter(prisma: PrismaClient) {
  const router = express.Router();

  const APP_URL =
    process.env.APP_URL ||
    (process.env.NODE_ENV !== "production" ? "http://localhost:5173" : "");

  if (!APP_URL) {
    throw new Error("Missing APP_URL");
  }

  router.post("/portal", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId;

      const sub = await prisma.subscription.findUnique({
        where: { organizationId: orgId },
      });

      if (!sub?.stripeCustomerId) {
        return res.status(404).json({
          ok: false,
          error: "No Stripe customer found",
        });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: `${APP_URL}/billing`,
      });

      return res.json({
        ok: true,
        url: session.url,
      });
    } catch (e: any) {
      console.error("billing portal error", e);
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  });

  return router;
}