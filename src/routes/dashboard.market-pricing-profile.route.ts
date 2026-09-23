import type { PrismaClient } from "@prisma/client";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

import {
  configureMarketPricingProfile,
  getMarketPricingProfileConfiguration,
  type ConfigureMarketPricingProfileInput,
} from "../services/market-pricing-profile-configuration.service";

const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);
const CONFIGURATION_FIELDS = new Set([
  "enabled",
  "currency",
  "strategy",
  "position",
  "aggressiveness",
  "minimumConfidence",
  "maximumIncreasePercent",
  "maximumDecreasePercent",
  "marketRadiusKm",
  "maximumComparables",
]);
const BAD_REQUEST_CODES = new Set([
  "MARKET_PRICING_PROPERTY_ID_REQUIRED",
  "MARKET_PRICING_CONFIGURATION_BODY_INVALID",
  "MARKET_PRICING_CONFIGURATION_FIELD_NOT_ALLOWED",
  "MARKET_PRICING_ENABLED_INVALID",
  "MARKET_PRICING_CURRENCY_INVALID",
  "MARKET_PRICING_STRATEGY_INVALID",
  "MARKET_PRICING_POSITION_INVALID",
  "MARKET_PRICING_AGGRESSIVENESS_INVALID",
  "MARKET_PRICING_MINIMUM_CONFIDENCE_INVALID",
  "MARKET_PRICING_MAXIMUM_INCREASE_INVALID",
  "MARKET_PRICING_MAXIMUM_DECREASE_INVALID",
  "MARKET_PRICING_RADIUS_INVALID",
  "MARKET_PRICING_MAXIMUM_COMPARABLES_INVALID",
]);

type Actor = Readonly<{ id: string; organizationId: string; role: string }>;

export type MarketPricingProfileRouteStoredProfile = Readonly<{
  propertyId: string;
  enabled: boolean;
  provider: string | null;
  currency: string;
  strategy: string;
  position: string;
  aggressiveness: string;
  minimumConfidence: unknown;
  maximumIncreasePercent: unknown;
  maximumDecreasePercent: unknown;
  marketRadiusKm: unknown;
  maximumComparables: number;
  refreshIntervalHours: number;
  lastSuccessfulRefreshAt: Date | null;
  nextRefreshAt: Date | null;
  lastErrorCode: string | null;
  updatedAt: Date;
}>;

export type MarketPricingProfileRouteActions = Readonly<{
  read(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<
    | { configured: false; profile: null }
    | { configured: true; profile: MarketPricingProfileRouteStoredProfile }
  >;
  configure(input: {
    organizationId: string;
    propertyId: string;
    configuration: ConfigureMarketPricingProfileInput["configuration"];
  }): Promise<MarketPricingProfileRouteStoredProfile>;
}>;

export function createPrismaMarketPricingProfileRouteActions(
  prisma: PrismaClient,
): MarketPricingProfileRouteActions {
  return {
    read: (input) => getMarketPricingProfileConfiguration(prisma, input),
    configure: (input) => configureMarketPricingProfile(prisma, input),
  };
}

function actor(req: Request): Actor | null {
  const user = (req as Request & {
    user?: { id?: string; orgId?: string; role?: string };
  }).user;
  if (
    !user?.id ||
    !user.orgId ||
    !user.role ||
    !ADMIN_ROLES.has(user.role)
  ) {
    return null;
  }
  return { id: user.id, organizationId: user.orgId, role: user.role };
}

function propertyId(req: Request): string {
  const value = String(req.params.propertyId ?? "").trim();
  if (!value) throw routeError(400, "MARKET_PRICING_PROPERTY_ID_REQUIRED");
  return value;
}

function configurationBody(
  req: Request,
): ConfigureMarketPricingProfileInput["configuration"] {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw routeError(400, "MARKET_PRICING_CONFIGURATION_BODY_INVALID");
  }
  const input = req.body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!CONFIGURATION_FIELDS.has(key)) {
      throw routeError(400, "MARKET_PRICING_CONFIGURATION_FIELD_NOT_ALLOWED");
    }
  }
  return input as ConfigureMarketPricingProfileInput["configuration"];
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("MARKET_PRICING_STORED_NUMBER_INVALID");
  }
  return number;
}

function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("MARKET_PRICING_STORED_DATE_INVALID");
  }
  return value.toISOString();
}

function serializeProfile(profile: MarketPricingProfileRouteStoredProfile) {
  return {
    configured: true,
    propertyId: profile.propertyId,
    enabled: profile.enabled,
    providerAssigned: Boolean(String(profile.provider ?? "").trim()),
    currency: profile.currency,
    strategy: profile.strategy,
    position: profile.position,
    aggressiveness: profile.aggressiveness,
    minimumConfidence: decimal(profile.minimumConfidence),
    maximumIncreasePercent: decimal(profile.maximumIncreasePercent),
    maximumDecreasePercent: decimal(profile.maximumDecreasePercent),
    marketRadiusKm: decimal(profile.marketRadiusKm),
    maximumComparables: profile.maximumComparables,
    refreshIntervalHours: profile.refreshIntervalHours,
    lastSuccessfulRefreshAt: date(profile.lastSuccessfulRefreshAt),
    nextRefreshAt: date(profile.nextRefreshAt),
    lastErrorCode: profile.lastErrorCode,
    updatedAt: date(profile.updatedAt),
  };
}

function routeError(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
}

function sendError(res: Response, error: unknown) {
  const value = error as { status?: number; code?: string; message?: string };
  const code = value?.code ?? value?.message ?? "MARKET_PRICING_ROUTE_ERROR";
  if (code === "MARKET_PRICING_PROPERTY_NOT_FOUND") {
    return res.status(404).json({ ok: false, error: code });
  }
  if (code === "MARKET_PRICING_PROVIDER_REQUIRED_FOR_ACTIVATION") {
    return res.status(409).json({ ok: false, error: code });
  }
  if (BAD_REQUEST_CODES.has(code)) {
    return res.status(value.status ?? 400).json({ ok: false, error: code });
  }

  console.error("[MARKET_PRICING_PROFILE_ROUTE_ERROR]", error);
  return res.status(500).json({ ok: false, error: "MARKET_PRICING_ROUTE_ERROR" });
}

export function buildDashboardMarketPricingProfileRouter(input: {
  auth: RequestHandler;
  actions: MarketPricingProfileRouteActions;
}) {
  const router = Router();
  const path = "/api/dashboard/properties/:propertyId/market-pricing";

  router.use(path, input.auth, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!actor(req)) {
      return res.status(403).json({
        ok: false,
        error: "MARKET_PRICING_ADMIN_FORBIDDEN",
      });
    }
    return next();
  });

  router.get(path, async (req, res) => {
    try {
      const currentActor = actor(req)!;
      const id = propertyId(req);
      const result = await input.actions.read({
        organizationId: currentActor.organizationId,
        propertyId: id,
      });
      return res.json({
        ok: true,
        propertyId: id,
        marketPricing: result.configured
          ? serializeProfile(result.profile)
          : { configured: false },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.put(path, async (req, res) => {
    try {
      const currentActor = actor(req)!;
      const id = propertyId(req);
      const profile = await input.actions.configure({
        organizationId: currentActor.organizationId,
        propertyId: id,
        configuration: configurationBody(req),
      });
      return res.json({
        ok: true,
        propertyId: id,
        marketPricing: serializeProfile(profile),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
