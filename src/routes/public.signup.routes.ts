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

type SignupCheckoutBody = {
  email?: string;
  password?: string;
  fullName?: string;
  organizationName?: string;
  phone?: string;
  locks?: number;
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

    console.log("🧪 signup checkout request", {
      appUrl: APP_URL,
      stripePrice: STRIPE_PRICE_LOCK_MONTHLY,
      email,
      organizationName,
      locks,
    });

    if (!STRIPE_PRICE_LOCK_MONTHLY) {
      return res.status(500).json({
        ok: false,
        error: "Missing STRIPE_PRICE_LOCK_MONTHLY",
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
        error: "Locks must be an integer greater than or equal to 1",
      });
    }

    const existingUser = await prisma.dashboardUser.findUnique({
      where: { email },
      select: { id: true, email: true },
    });

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        error: "An account already exists with that email",
      });
    }

    const passwordHash = await bcrypt.hash(password.trim(), 10);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const existingPending = await prisma.pendingSignup.findFirst({
      where: {
        email,
        status: {
          in: [PendingSignupStatus.PENDING, PendingSignupStatus.CHECKOUT_CREATED],
        },
      },
      orderBy: { createdAt: "desc" },
    });

    let pendingSignup;

    if (
      existingPending &&
      (!existingPending.expiresAt || existingPending.expiresAt > new Date())
    ) {
      pendingSignup = await prisma.pendingSignup.update({
        where: { id: existingPending.id },
        data: {
          passwordHash,
          fullName,
          organizationName,
          phone,
          requestedLocks: locks,
          stripeCheckoutSessionId: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripePriceId: STRIPE_PRICE_LOCK_MONTHLY,
          status: PendingSignupStatus.PENDING,
          expiresAt,
          metadata: {
            flow: "signup_onboarding",
          },
        },
      });

      console.log("♻️ reused pending signup", {
        pendingSignupId: pendingSignup.id,
        email: pendingSignup.email,
      });
    } else {
      pendingSignup = await prisma.pendingSignup.create({
        data: {
          email,
          passwordHash,
          fullName,
          organizationName,
          phone,
          requestedLocks: locks,
          stripePriceId: STRIPE_PRICE_LOCK_MONTHLY,
          status: PendingSignupStatus.PENDING,
          expiresAt,
          metadata: {
            flow: "signup_onboarding",
          },
        },
      });

      console.log("🆕 created pending signup", {
        pendingSignupId: pendingSignup.id,
        email: pendingSignup.email,
      });
    }

    const customer = await stripe.customers.create({
      email,
      name: fullName ?? organizationName,
      phone: phone ?? undefined,
      metadata: {
        flow: "signup_onboarding",
        pendingSignupId: pendingSignup.id,
        organizationName,
      },
    });

    console.log("👤 stripe customer created", {
      customerId: customer.id,
      pendingSignupId: pendingSignup.id,
      email,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [
        {
          price: STRIPE_PRICE_LOCK_MONTHLY,
          quantity: locks,
        },
      ],
      success_url: `${APP_URL}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/signup/cancel?pending_signup_id=${pendingSignup.id}`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          flow: "signup_onboarding",
          pendingSignupId: pendingSignup.id,
          signupEmail: email,
        },
      },
      metadata: {
        flow: "signup_onboarding",
        pendingSignupId: pendingSignup.id,
        signupEmail: email,
      },
    });

    console.log("🧾 Stripe session raw", {
      id: session.id,
      url: session.url,
      mode: session.mode,
      customer: session.customer,
      payment_status: session.payment_status,
      status: session.status,
    });

    if (!session.url) {
      console.error("❌ Stripe session created without url", {
        sessionId: session.id,
        pendingSignupId: pendingSignup.id,
      });

      return res.status(500).json({
        ok: false,
        error: "Stripe checkout session was created without a redirect URL",
      });
    }

    await prisma.pendingSignup.update({
      where: { id: pendingSignup.id },
      data: {
        stripeCustomerId: customer.id,
        stripeCheckoutSessionId: session.id,
        status: PendingSignupStatus.CHECKOUT_CREATED,
      },
    });

    console.log("✅ signup checkout session created", {
      pendingSignupId: pendingSignup.id,
      customerId: customer.id,
      sessionId: session.id,
      sessionUrl: session.url,
    });

    return res.status(200).json({
      ok: true,
      url: session.url,
      pendingSignupId: pendingSignup.id,
    });
  } catch (error: any) {
    console.error("🔥 signup-checkout error:", {
      message: error?.message ?? "Unknown error",
      type: error?.type,
      code: error?.code,
      raw: error,
    });

    return res.status(500).json({
      ok: false,
      error: error?.message ?? "Internal server error",
    });
  }
});

router.get("/api/public/signup-success-status", async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.query.session_id ?? "").trim();

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing session_id",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    const pendingSignupId = String(session.metadata?.pendingSignupId ?? "").trim();

    if (!pendingSignupId) {
      return res.status(400).json({
        ok: false,
        error: "Missing pendingSignupId in session metadata",
      });
    }

    const isPaid =
      session.payment_status === "paid" ||
      session.status === "complete" ||
      (typeof session.subscription === "object" &&
        !!session.subscription &&
        "status" in session.subscription &&
        (session.subscription.status === "active" ||
          session.subscription.status === "trialing"));

    if (!isPaid) {
      return res.json({
        ok: true,
        ready: false,
        autoLoggedIn: false,
        status: "PAYMENT_PENDING",
      });
    }

    const pending = await prisma.pendingSignup.findUnique({
      where: { id: pendingSignupId },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        fullName: true,
        organizationName: true,
        phone: true,
        requestedLocks: true,
        stripePriceId: true,
        stripeCustomerId: true,
        stripeCheckoutSessionId: true,
        stripeSubscriptionId: true,
        status: true,
        organizationId: true,
        completedAt: true,
        expiresAt: true,
      },
    });

    if (!pending) {
      return res.status(404).json({
        ok: false,
        error: "PendingSignup not found",
      });
    }

    let organizationId = pending.organizationId ?? null;

    if (pending.status !== PendingSignupStatus.COMPLETED || !organizationId) {
      const existingUser = await prisma.dashboardUser.findUnique({
        where: { email: pending.email },
        select: {
          id: true,
          organizationId: true,
        },
      });

      if (existingUser) {
        organizationId = existingUser.organizationId;

        await prisma.pendingSignup.update({
          where: { id: pending.id },
          data: {
            organizationId,
            stripeCheckoutSessionId: session.id,
            stripeCustomerId:
              typeof session.customer === "string"
                ? session.customer
                : session.customer?.id ?? pending.stripeCustomerId ?? null,
            stripeSubscriptionId:
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id ?? pending.stripeSubscriptionId ?? null,
            status: PendingSignupStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      } else {
        const created = await prisma.organization.create({
          data: {
            name: pending.organizationName,
            dashboardUsers: {
              create: {
                email: pending.email,
                passwordHash: pending.passwordHash,
                fullName: pending.fullName,
                role: "ADMIN",
                isActive: true,
              },
            },
          },
          include: {
            dashboardUsers: {
              select: {
                id: true,
                organizationId: true,
                email: true,
              },
            },
          },
        });

        organizationId = created.id;

        await prisma.pendingSignup.update({
          where: { id: pending.id },
          data: {
            organizationId,
            stripeCheckoutSessionId: session.id,
            stripeCustomerId:
              typeof session.customer === "string"
                ? session.customer
                : session.customer?.id ?? pending.stripeCustomerId ?? null,
            stripeSubscriptionId:
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id ?? pending.stripeSubscriptionId ?? null,
            status: PendingSignupStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      }
    }

    const user = await prisma.dashboardUser.findUnique({
      where: { email: pending.email },
      select: {
        id: true,
        email: true,
        organizationId: true,
        role: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    if (!user || !user.isActive) {
      return res.json({
        ok: true,
        ready: false,
        autoLoggedIn: false,
        status: "USER_NOT_READY",
      });
    }

    const token = signAuthToken({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    await prisma.dashboardUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.setHeader("Set-Cookie", buildAuthCookie(token));

    console.log("🍪 signup-success-status cookie set", {
      email: user.email,
      orgId: user.organizationId,
    });

    return res.json({
      ok: true,
      ready: true,
      autoLoggedIn: true,
      user: {
        id: user.id,
        email: user.email,
        orgId: user.organizationId,
        role: user.role,
      },
    });
  } catch (error: any) {
    console.error("🔥 signup-success-status error:", {
      message: error?.message ?? "Unknown error",
      raw: error,
    });

    return res.status(500).json({
      ok: false,
      error: error?.message ?? "Internal server error",
    });
  }
});

export default router;