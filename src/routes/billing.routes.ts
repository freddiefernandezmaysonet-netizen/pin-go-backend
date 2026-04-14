import express from "express";
import { PrismaClient } from "@prisma/client";
import stripe from "../billing/stripe";
import { requireAuth } from "../middleware/requireAuth";

export function buildBillingRouter(prisma: PrismaClient) {
  const router = express.Router();

  const PRICE_ID = process.env.STRIPE_PRICE_HOST_MONTHLY;

  const APP_URL =
    process.env.APP_URL ||
    (process.env.NODE_ENV !== "production" ? "http://localhost:5173" : "");

  if (!APP_URL) {
    throw new Error("Missing APP_URL");
  }

  if (!PRICE_ID) {
    console.warn("[billing] Missing STRIPE_PRICE_HOST_MONTHLY in .env");
  }

  /*
  ---------------------------------------------------------
  BASIC CHECKOUT SESSION (PERSON BASED)
  ---------------------------------------------------------
  */

  router.post("/checkout-session", async (req, res) => {
    try {
      const { personId, organizationId, email, fullName } = req.body ?? {};

      if (!PRICE_ID) {
        return res.status(500).json({
          ok: false,
          error: "Missing STRIPE_PRICE_HOST_MONTHLY",
        });
      }

      let person = null;

      if (personId) {
        person = await prisma.person.findUnique({
          where: { id: String(personId) },
        });

        if (!person) {
          return res.status(404).json({
            ok: false,
            error: "Person not found",
          });
        }
      } else {
        if (!organizationId || !fullName) {
          return res.status(400).json({
            ok: false,
            error: "Missing personId OR (organizationId, fullName)",
          });
        }

        person = await prisma.person.create({
          data: {
            organizationId: String(organizationId),
            role: "MANAGER",
            fullName: String(fullName),
            email: email ? String(email) : null,
          } as any,
        });
      }

      let customerId = person.stripeCustomerId ?? null;

      if (!customerId) {
        const customer = await stripe.customers.create({
          name: person.fullName,
          email: person.email ?? undefined,
          metadata: {
            personId: person.id,
            organizationId: person.organizationId,
          },
        });

        customerId = customer.id;

        await prisma.person.update({
          where: { id: person.id },
          data: { stripeCustomerId: customerId },
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [
          {
            price: PRICE_ID,
            quantity: 1,
          },
        ],
        success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/billing/cancel`,
        allow_promotion_codes: true,
        subscription_data: {
          metadata: {
            personId: person.id,
            organizationId: person.organizationId,
          },
        },
        metadata: {
          personId: person.id,
          organizationId: person.organizationId,
        },
      });

      return res.json({
        ok: true,
        url: session.url,
        sessionId: session.id,
        personId: person.id,
      });
    } catch (e: any) {
      console.error("billing/checkout-session error:", e?.message ?? e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "checkout-session failed",
      });
    }
  });

  /*
  ---------------------------------------------------------
  LOCKS SUBSCRIPTION CHECKOUT
  ---------------------------------------------------------
  */

  router.post("/locks/checkout-session", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;

      const { locks, email, fullName } = req.body ?? {};

      const PRICE_LOCKS = process.env.STRIPE_PRICE_LOCK_MONTHLY;

      if (!PRICE_LOCKS) {
        return res.status(500).json({
          ok: false,
          error: "Missing STRIPE_PRICE_LOCK_MONTHLY",
        });
      }

      const orgId = user?.orgId ? String(user.orgId) : null;

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const qty = Number(locks);

      if (!Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({
          ok: false,
          error: "locks must be integer >= 1",
        });
      }

      const sub = await prisma.subscription.upsert({
        where: { organizationId: orgId },
        create: {
          organizationId: orgId,
          status: "INCOMPLETE",
          entitledLocks: 0,
        },
        update: {},
        select: {
          id: true,
          stripeCustomerId: true,
        },
      });

      let customerId = sub.stripeCustomerId ?? null;

      if (!customerId) {
        const customer = await stripe.customers.create({
          name: fullName ? String(fullName) : undefined,
          email: email ? String(email) : undefined,
          metadata: {
            organizationId: orgId,
          },
        });

        customerId = customer.id;

        await prisma.subscription.update({
          where: { organizationId: orgId },
          data: { stripeCustomerId: customerId },
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [
          {
            price: PRICE_LOCKS,
            quantity: qty,
          },
        ],
        success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/billing/cancel`,
        allow_promotion_codes: true,
        subscription_data: {
          metadata: {
            organizationId: orgId,
          },
        },
        metadata: {
          organizationId: orgId,
        },
      });

      return res.json({
        ok: true,
        url: session.url,
        sessionId: session.id,
        organizationId: orgId,
        quantity: qty,
      });
    } catch (e: any) {
      console.error("billing/locks/checkout-session error:", e?.message ?? e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "locks checkout-session failed",
      });
    }
  });

  /*
  ---------------------------------------------------------
  SMART PROPERTIES CHECKOUT
  ---------------------------------------------------------
  */

  router.post("/smart/checkout-session", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = String(user?.orgId ?? "");

      const { quantity } = req.body ?? {};

      const PRICE_SMART = process.env.STRIPE_PRICE_SMART_PROPERTY;

      if (!PRICE_SMART) {
        return res.status(500).json({
          ok: false,
          error: "Missing STRIPE_PRICE_SMART_PROPERTY",
        });
      }

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const qty = Number(quantity);

      if (!Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({
          ok: false,
          error: "quantity must be integer >= 1",
        });
      }

      const sub = await prisma.subscription.findUnique({
        where: { organizationId: orgId },
      });

      if (!sub?.stripeCustomerId) {
        return res.status(400).json({
          ok: false,
          error: "NO_STRIPE_CUSTOMER",
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: sub.stripeCustomerId,
        line_items: [
          {
            price: PRICE_SMART,
            quantity: qty,
          },
        ],
        success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/billing/cancel`,
        allow_promotion_codes: true,
        subscription_data: {
          metadata: {
            organizationId: orgId,
          },
        },
        metadata: {
          organizationId: orgId,
        },
      });

      return res.json({
        ok: true,
        url: session.url,
        sessionId: session.id,
        organizationId: orgId,
        quantity: qty,
      });
    } catch (e: any) {
      console.error("billing/smart/checkout-session error:", e?.message ?? e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "smart checkout-session failed",
      });
    }
  });

  return router;
}