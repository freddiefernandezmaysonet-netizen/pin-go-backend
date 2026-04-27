import { Router } from "express";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { PrismaClient, PendingSignupStatus } from "@prisma/client";
import stripe from "../billing/stripe";
import { buildAuthCookie, signAuthToken } from "../lib/auth";
import { validatePasswordPolicy } from "../lib/passwordPolicy";

const router = Router();
const prisma = new PrismaClient();

const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
const STRIPE_PRICE_LOCK_MONTHLY = process.env.STRIPE_PRICE_LOCK_MONTHLY ?? "";
const STRIPE_PRICE_LOCK_YEARLY = process.env.STRIPE_PRICE_LOCK_YEARLY ?? "";

type SignupCheckoutBody = {
  email?: string;
  password?: string;
  fullName?: string;
  organizationName?: string;
  phone?: string;
  locks?: number;
  billingInterval?: "monthly" | "yearly"; // ✅ ADD
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/api/public/signup-checkout", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as SignupCheckoutBody;

    const email = normalizeEmail(String(body.email ?? ""));
    const password = String(body.password ?? "");
    const fullName = body.fullName?.trim() || null;
    const organizationName = String(body.organizationName ?? "").trim();
    const phone = body.phone?.trim() || null;
    const locks = Number(body.locks ?? 1);

    // ✅ NUEVO
    const billingInterval = body.billingInterval === "yearly" ? "yearly" : "monthly";

    const PRICE_ID =
      billingInterval === "yearly"
        ? STRIPE_PRICE_LOCK_YEARLY
        : STRIPE_PRICE_LOCK_MONTHLY;

    console.log("🧪 signup checkout request", {
      billingInterval,
      priceId: PRICE_ID,
      email,
      organizationName,
      locks,
    });

    if (!PRICE_ID) {
      return res.status(500).json({
        ok: false,
        error: "Missing Stripe price for selected interval",
      });
    }

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "Valid email is required",
      });
    }

    const passwordPolicy = validatePasswordPolicy(password, {
      email,
      fullName,
      organizationName,
    });

    if (!passwordPolicy.ok) {
      return res.status(400).json({
        ok: false,
        error: "WEAK_PASSWORD",
        details: passwordPolicy.errors,
      });
    }

    if (!organizationName) {
      return res.status(400).json({
        ok: false,
        error: "Organization name is required",
      });
    }

    if (!Number.isInteger(locks) || locks < 1) {
      return res.status(400).json({
        ok: false,
        error: "Locks must be >= 1",
      });
    }

    const existingUser = await prisma.dashboardUser.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        error: "Account already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password.trim(), 10);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const pendingSignup = await prisma.pendingSignup.create({
      data: {
        email,
        passwordHash,
        fullName,
        organizationName,
        phone,
        requestedLocks: locks,
        stripePriceId: PRICE_ID, // ✅ dinámico
        status: PendingSignupStatus.PENDING,
        expiresAt,
      },
    });

    const customer = await stripe.customers.create({
      email,
      name: fullName ?? organizationName,
      phone: phone ?? undefined,
      metadata: {
        pendingSignupId: pendingSignup.id,
      },
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [
        {
          price: PRICE_ID, // ✅ dinámico
          quantity: locks,
        },
      ],
      success_url: `${APP_URL}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/signup/cancel`,
      subscription_data: {
        metadata: {
          pendingSignupId: pendingSignup.id,
        },
      },
      metadata: {
        pendingSignupId: pendingSignup.id,
      },
    });

    await prisma.pendingSignup.update({
      where: { id: pendingSignup.id },
      data: {
        stripeCustomerId: customer.id,
        stripeCheckoutSessionId: session.id,
        status: PendingSignupStatus.CHECKOUT_CREATED,
      },
    });

    return res.json({
      ok: true,
      url: session.url,
    });
  } catch (error: any) {
    console.error("🔥 signup-checkout error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message ?? "Internal server error",
    });
  }
});

export default router;