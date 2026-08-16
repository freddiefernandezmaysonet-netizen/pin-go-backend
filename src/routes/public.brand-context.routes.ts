import { Router, type Request } from "express";
import {
  resolvePublishedBrandContextByHostname,
  type PublishedBrandContext,
} from "../services/branding/published-brand-context.service.js";

export const publicBrandContextRouter = Router();

publicBrandContextRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Host, X-Forwarded-Host");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

function publicContext(context: PublishedBrandContext) {
  return {
    kind: context.kind,
    displayName: context.displayName,
    logoUrl: context.logoUrl,
    faviconUrl: context.faviconUrl,
    primaryColor: context.primaryColor,
    onPrimaryColor: context.onPrimaryColor,
    organizationSlug: context.organizationSlug,
    version: context.version,
    poweredByPinGo: context.poweredByPinGo,
  };
}

function rawRequestHostname(req: Request): string {
  return (
    req.get("x-forwarded-host") ??
    req.get("host") ??
    req.hostname
  );
}

publicBrandContextRouter.get(
  "/api/public/brand-context",
  async (req, res) => {
    try {
      const context = await resolvePublishedBrandContextByHostname(
        rawRequestHostname(req)
      );

      if (context.kind === "DOMAIN_UNAVAILABLE") {
        res.status(404).json({
          ok: false,
          error: "BRAND_DOMAIN_UNAVAILABLE",
        });
        return;
      }

      res.json({
        ok: true,
        data: publicContext(context),
      });
    } catch (error) {
      console.error("[PUBLIC_BRAND_CONTEXT_ROUTE_ERROR]", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({
        ok: false,
        error: "BRAND_CONTEXT_RESOLUTION_FAILED",
      });
    }
  }
);
