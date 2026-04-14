import { Router, type Request, type Response } from "express";
import Stripe from "stripe";

type PrismaLike = any;

const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY ?? "").trim();
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: "2025-02-24.acacia",
    })
  : null;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveOrgId(req: Request): string | null {
  const fromReq = normalizeString((req as any).orgId);
  if (fromReq) return fromReq;

  const fromOrg = normalizeString((req as any).org?.id);
  if (fromOrg) return fromOrg;

  const fromUser = normalizeString((req as any).user?.orgId);
  if (fromUser) return fromUser;

  const fromBody = normalizeString((req as any).body?.organizationId);
  if (fromBody) return fromBody;

  const fromQuery = normalizeString((req as any).query?.organizationId);
  if (fromQuery) return fromQuery;

  return null;
}

function resolveEmail(req: Request): string {
  return normalizeString(
    (req as any).user?.email ??
      (req as any).user?.primaryEmail ??
      (req as any).body?.email ??
      (req as any).query?.email
  );
}

function getFrontendBaseUrl(req: Request): string {
  const envUrl = normalizeString(process.env.FRONTEND_ORIGIN);
  if (envUrl) return envUrl;

  const originHeader = normalizeString(req.headers.origin);
  if (originHeader) return originHeader;

  return "http://localhost:5173";
}

function getTuyaPriceId(): string {
  return normalizeString(
    process.env.STRIPE_PRICE_TUYA_ADDON ??
      process.env.STRIPE_PRICE_TUYA_MONTHLY ??
      process.env.STRIPE_PRICE_TUYA_PREMIUM ??
      process.env.STRIPE_PRICE_TUYA
  );
}

async function loadOrganization(prisma: PrismaLike, orgId: string): Promise<any | null> {
  try {
    const db = prisma as any;
    if (!db?.organization?.findUnique) return null;

    return await db.organization.findUnique({
      where: { id: orgId },
    });
  } catch {
    return null;
  }
}

async function loadLatestSubscription(
  prisma: PrismaLike,
  orgId: string
): Promise<any | null> {
  const db = prisma as any;
  if (!db?.subscription?.findFirst) return null;

  try {
    return await db.subscription.findFirst({
      where: { organizationId: orgId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  } catch {
    //
  }

  try {
    return await db.subscription.findFirst({
      where: { orgId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  } catch {
    return null;
  }
}

function extractCustomerId(subscription: any, organization: any): string {
  return normalizeString(
    subscription?.stripeCustomerId ??
      subscription?.customerId ??
      subscription?.stripeCustomer?.id ??
      organization?.stripeCustomerId ??
      organization?.customerId
  );
}

function extractSubscriptionId(subscription: any): string {
  return normalizeString(
    subscription?.stripeSubscriptionId ??
      subscription?.subscriptionId ??
      subscription?.stripeId
  );
}

function buildSuccessUrl(baseUrl: string, orgId: string): string {
  const url = new URL("/billing/success", baseUrl);
  url.searchParams.set("feature", "tuya");
  url.searchParams.set("orgId", orgId);
  return url.toString();
}

function buildCancelUrl(baseUrl: string, orgId: string): string {
  const url = new URL("/billing", baseUrl);
  url.searchParams.set("feature", "tuya");
  url.searchParams.set("orgId", orgId);
  url.searchParams.set("checkout", "cancel");
  return url.toString();
}

export function buildTuyaBillingRouter(prisma: PrismaLike) {
  const router = Router();

  /**
   * GET /api/org/tuya/billing/config
   * Devuelve configuración útil para la UI.
   */
  router.get("/config", async (req: Request, res: Response) => {
    try {
      const orgId = resolveOrgId(req);
      const priceId = getTuyaPriceId();

      return res.json({
        ok: true,
        orgId,
        billing: {
          feature: "tuya",
          enabled: Boolean(priceId && stripe),
          priceIdConfigured: Boolean(priceId),
          checkoutMode: "subscription_addon",
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: "TUYA_BILLING_CONFIG_FAILED",
        message: error?.message || "Unexpected error while reading Tuya billing config",
      });
    }
  });

  /**
   * POST /api/org/tuya/billing/checkout-session
   *
   * Crea una Checkout Session para el add-on premium de Tuya.
   * Uso esperado:
   * - UI locked -> llama este endpoint
   * - Stripe checkout
   * - webhook actual / existente persiste la suscripción / item / entitlement
   */
  router.post("/checkout-session", async (req: Request, res: Response) => {
    try {
      if (!stripe) {
        return res.status(500).json({
          ok: false,
          error: "STRIPE_NOT_CONFIGURED",
        });
      }

      const orgId = resolveOrgId(req);
      if (!orgId) {
        return res.status(400).json({
          ok: false,
          error: "ORGANIZATION_ID_REQUIRED",
        });
      }

      const priceId = getTuyaPriceId();
      if (!priceId) {
        return res.status(500).json({
          ok: false,
          error: "TUYA_PRICE_ID_NOT_CONFIGURED",
        });
      }

      const frontendBaseUrl = getFrontendBaseUrl(req);
      const organization = await loadOrganization(prisma, orgId);
      const subscription = await loadLatestSubscription(prisma, orgId);

      const customerEmail = resolveEmail(req);
      const customerId = extractCustomerId(subscription, organization);
      const existingSubscriptionId = extractSubscriptionId(subscription);

      const metadata: Record<string, string> = {
        feature: "tuya",
        addon: "tuya",
        orgId,
      };

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        success_url: buildSuccessUrl(frontendBaseUrl, orgId),
        cancel_url: buildCancelUrl(frontendBaseUrl, orgId),
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        allow_promotion_codes: true,
        metadata,
        subscription_data: {
          metadata,
        },
      };

      if (customerId) {
        sessionParams.customer = customerId;
      } else if (customerEmail) {
        sessionParams.customer_email = customerEmail;
      }

      /**
       * Si ya existe una subscription activa/base, intentamos que el checkout
       * quede claramente marcado como add-on Tuya para que el webhook actual
       * pueda reconocerlo sin romper contratos existentes.
       *
       * No forzamos update de subscription aquí para evitar romper lógica actual.
       * Este endpoint crea una compra clara del feature premium.
       */
      if (existingSubscriptionId) {
        sessionParams.client_reference_id = existingSubscriptionId;
        sessionParams.metadata = {
          ...metadata,
          baseSubscriptionId: existingSubscriptionId,
        };
        sessionParams.subscription_data = {
          metadata: {
            ...metadata,
            baseSubscriptionId: existingSubscriptionId,
          },
        };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      return res.json({
        ok: true,
        feature: "tuya",
        checkout: {
          sessionId: session.id,
          url: session.url ?? null,
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: "TUYA_CHECKOUT_SESSION_FAILED",
        message:
          error?.message || "Unexpected error while creating Tuya checkout session",
      });
    }
  });

  return router;
}

export default buildTuyaBillingRouter;