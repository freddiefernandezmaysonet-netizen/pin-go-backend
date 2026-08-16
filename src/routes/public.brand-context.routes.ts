import { Router, type Request } from "express";
import {
  isPinGoStandardHostname,
  normalizeBrandHostname,
  resolvePublishedBrandContextByHostname,
  type PublishedBrandContext,
} from "../services/branding/published-brand-context.service.js";

export const publicBrandContextRouter = Router();

const BRAND_PROXY_HOSTNAME_HEADER = "x-pin-go-brand-hostname";

publicBrandContextRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Vary",
    "Host, X-Forwarded-Host, X-Pin-Go-Brand-Hostname"
  );
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
  const proxyHostname =
    req.get("x-forwarded-host") ??
    req.get("host") ??
    req.hostname;
  const requestedBrandHostname = req.get(BRAND_PROXY_HOSTNAME_HEADER);

  if (!requestedBrandHostname) return proxyHostname;

  const normalizedProxyHostname = normalizeBrandHostname(proxyHostname);
  if (
    !normalizedProxyHostname ||
    !isPinGoStandardHostname(normalizedProxyHostname)
  ) {
    return proxyHostname;
  }

  return requestedBrandHostname;
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
