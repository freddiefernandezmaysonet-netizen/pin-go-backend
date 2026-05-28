import { Router } from "express";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { PrismaClient, PendingSignupStatus } from "@prisma/client";
import stripe from "../billing/stripe";
import { buildAuthCookie, signAuthToken } from "../lib/auth";
import { validatePasswordPolicy } from "../lib/passwordPolicy";

function getSaasLocksVolumeCouponId(lockQuantity: number): string | undefined {
  if (!Number.isFinite(lockQuantity) || lockQuantity <= 0) {
    return undefined;
  }

  if (lockQuantity >= 25) {
    return process.env.STRIPE_SAAS_LOCKS_20_OFF_COUPON_ID;
  }

  if (lockQuantity >= 10) {
    return process.env.STRIPE_SAAS_LOCKS_15_OFF_COUPON_ID;
  }

  if (lockQuantity >= 5) {
    return process.env.STRIPE_SAAS_LOCKS_10_OFF_COUPON_ID;
  }

  return undefined;
}

const router = Router();
const prisma = new PrismaClient();

const APP_URL = process.env.APP_URL ?? "http://localhost:5173";

const STRIPE_PRICE_LOCK_MONTHLY =
  process.env.STRIPE_PRICE_LOCK_MONTHLY ?? "";

const STRIPE_PRICE_LOCK_YEARLY =
  process.env.STRIPE_PRICE_LOCK_YEARLY ?? "";

const STRIPE_PRICE_CONTRACT_24_LOCK =
  process.env.STRIPE_PRICE_CONTRACT_24_LOCK ?? "";

const STRIPE_PRICE_CONTRACT_24_LOCK_1_SMART =
  process.env.STRIPE_PRICE_CONTRACT_24_LOCK_1_SMART ?? "";

const STRIPE_PRICE_CONTRACT_24_LOCK_2_SMART =
  process.env.STRIPE_PRICE_CONTRACT_24_LOCK_2_SMART ?? "";
type BillingInterval = "monthly" | "yearly";

type ContractOption =
  | "standard"
  | "contract_24_lock"
  | "contract_24_lock_1_smart"
  | "contract_24_lock_2_smart";

type SignupCheckoutBody = {
  email?: string;
  password?: string;
  fullName?: string;
  organizationName?: string;
  phone?: string;
  locks?: number;
  billingInterval?: BillingInterval;
  contractOption?: ContractOption;

  haasSelection?: {
    plan?: string;
    lock?: string;
    smartDevices?: string;
  };

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
    const haasSelection = body.haasSelection ?? null;
    
    const billingInterval: BillingInterval =
      body.billingInterval === "yearly" ? "yearly" : "monthly";

    const contractOption: ContractOption =
  body.contractOption === "contract_24_lock" ||
  body.contractOption === "contract_24_lock_1_smart" ||
  body.contractOption === "contract_24_lock_2_smart"
    ? body.contractOption
    : "standard";
    
    const STRIPE_PRICE_HAAS_ESSENTIAL_LOCK_MONTHLY =
      process.env.STRIPE_PRICE_HAAS_ESSENTIAL_LOCK_MONTHLY ?? "";

    const STRIPE_PRICE_HAAS_PRO_LOCK_MONTHLY =
      process.env.STRIPE_PRICE_HAAS_PRO_LOCK_MONTHLY ?? "";

    const STRIPE_PRICE_HAAS_ELITE_LOCK_MONTHLY =
      process.env.STRIPE_PRICE_HAAS_ELITE_LOCK_MONTHLY ?? "";

    const STRIPE_PRICE_HAAS_SMART_1_MONTHLY =
      process.env.STRIPE_PRICE_HAAS_SMART_1_MONTHLY ?? "";

    const STRIPE_PRICE_HAAS_SMART_2_MONTHLY =
      process.env.STRIPE_PRICE_HAAS_SMART_2_MONTHLY ?? "";

    const isHaasCheckout = contractOption !== "standard" && !!haasSelection;

    const lockHaasPriceId =
      haasSelection?.lock === "essential"
        ? STRIPE_PRICE_HAAS_ESSENTIAL_LOCK_MONTHLY
        : haasSelection?.lock === "pro"
          ? STRIPE_PRICE_HAAS_PRO_LOCK_MONTHLY
          : haasSelection?.lock === "elite"
            ? STRIPE_PRICE_HAAS_ELITE_LOCK_MONTHLY
            : "";

const smartHaasPriceId =
  haasSelection?.smartDevices === "1" ||
  haasSelection?.smartDevices === "one"
    ? STRIPE_PRICE_HAAS_SMART_1_MONTHLY
    : haasSelection?.smartDevices === "2" ||
      haasSelection?.smartDevices === "two"
      ? STRIPE_PRICE_HAAS_SMART_2_MONTHLY
      : "";
    
    const PRICE_ID =
      isHaasCheckout
        ? lockHaasPriceId
        : contractOption === "contract_24_lock"
          ? STRIPE_PRICE_CONTRACT_24_LOCK
          : contractOption === "contract_24_lock_1_smart"
            ? STRIPE_PRICE_CONTRACT_24_LOCK_1_SMART
            : contractOption === "contract_24_lock_2_smart"
              ? STRIPE_PRICE_CONTRACT_24_LOCK_2_SMART
              : billingInterval === "yearly"
                ? STRIPE_PRICE_LOCK_YEARLY
                : STRIPE_PRICE_LOCK_MONTHLY;

    const lineItems = isHaasCheckout
      ? [
          {
            price: lockHaasPriceId,
            quantity: 1,
          },
          ...(smartHaasPriceId
            ? [
                {
                 price: smartHaasPriceId,
                 quantity: 1,
               },
             ]
           : []),
        ]
      : [
      {
        price: PRICE_ID,
        quantity: locks,
      },
    ]; 
   
const saasVolumeCouponId =
  !isHaasCheckout && contractOption === "standard"
    ? getSaasLocksVolumeCouponId(locks)
    : undefined;
 
  console.log("🧪 signup checkout request", {
  billingInterval,
  contractOption,
  priceId: PRICE_ID,
  email,
  organizationName,
  locks,
  haasSelection,
  lineItems,
  saasVolumeCouponId: saasVolumeCouponId ? "SET" : "NOT_SET",
});
   
   if (!PRICE_ID) {
      return res.status(500).json({
        ok: false,
        error: "Missing Stripe price for selected subscription",
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
        stripePriceId: PRICE_ID,
       

        metadata: haasSelection
          ? {
              haasSelection,
              contractOption,
            }
          : null,
       

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
        contractOption,

        haasPlan: haasSelection?.plan ?? "",
        haasLock: haasSelection?.lock ?? "",
        haasSmartDevices: haasSelection?.smartDevices ?? "",
      },
    });

const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  customer: customer.id,
  line_items: lineItems,
  discounts: saasVolumeCouponId
    ? [{ coupon: saasVolumeCouponId }]
    : undefined,
      success_url: `${APP_URL}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/signup/cancel`,
      subscription_data: {
       metadata: {
         pendingSignupId: pendingSignup.id,
         contractOption,

         haasPlan: haasSelection?.plan ?? "",
         haasLock: haasSelection?.lock ?? "",
         haasSmartDevices: haasSelection?.smartDevices ?? "",
       },

      },
     metadata: {
       pendingSignupId: pendingSignup.id,
       contractOption,

       haasPlan: haasSelection?.plan ?? "",
       haasLock: haasSelection?.lock ?? "",
       haasSmartDevices: haasSelection?.smartDevices ?? "",
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