import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth.js";
import {
  createDistributionMutationSecurity,
  type DistributionMutationRequest,
} from "../distribution/distribution-mutation-security.js";

const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);

type Actor = { id?: string; orgId?: string; role?: string };
type AirbnbListingSummary = { id: string; title: string };

export type AirbnbHostSelfServiceRouteActions = {
  enabled: boolean;
  isTrustedOrigin(origin: string, organizationId: string): Promise<boolean>;
  issueConnectionLink(args: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    requestKey: string;
  }): Promise<{ authorizationUrl: string; expiresAt: Date }>;
  verifyCallback(args: {
    organizationId: string;
    requestedByUserId: string;
    success: string;
    channelId?: string | null;
    token: string;
  }): Promise<{
    success: boolean;
    propertyId: string | null;
    channelId: string | null;
    channelActive: boolean | null;
    airbnbAccountVerified: false;
    nextAction: "RETRY_AUTHORIZATION" | "LISTING_DISCOVERY_REQUIRED";
  }>;
  discoverListings(args: {
    organizationId: string;
    propertyId: string;
    channelId: string;
  }): Promise<{
    propertyId: string;
    channelId: string;
    airbnbAccountVerified: true;
    listings: AirbnbListingSummary[];
    nextAction: "MAPPING_REQUIRED";
  }>;
};

function failure(res: import("express").Response, error: unknown, fallback: string) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : fallback;
  const status = code.includes("NOT_FOUND")
    ? 404
    : code.includes("FORBIDDEN") || code.includes("TENANT") || code.includes("ACTOR")
      ? 403
      : code.includes("RATE_LIMITED")
        ? 429
        : code.includes("UNAVAILABLE")
          ? 503
          : 422;
  return res.status(status).json({ ok: false, error: code });
}

function actor(req: DistributionMutationRequest): Required<Actor> | null {
  const value = req.user as Actor | undefined;
  if (
    !value?.id ||
    !value.orgId ||
    !ADMIN_ROLES.has(String(value.role ?? ""))
  ) {
    return null;
  }
  return value as Required<Actor>;
}

export function buildDashboardAirbnbHostSelfServiceRouter(
  actions: AirbnbHostSelfServiceRouteActions
) {
  const router = Router();
  const mutationSecurity = createDistributionMutationSecurity({
    isTrustedOrigin: actions.isTrustedOrigin,
  });

  router.post(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/connection-link",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled) {
        return res.status(503).json({
          ok: false,
          error: "OTA_AIRBNB_HOST_SELF_SERVICE_DISABLED",
        });
      }
      const currentActor = actor(req);
      if (!currentActor) {
        return res.status(403).json({ ok: false, error: "OTA_CONNECTION_MUTATION_FORBIDDEN" });
      }
      try {
        const result = await actions.issueConnectionLink({
          organizationId: currentActor.orgId,
          propertyId: String(req.params.propertyId ?? "").trim(),
          requestedByUserId: currentActor.id,
          requestKey: req.distributionRequestKey!,
        });
        return res.json({
          ok: true,
          authorizationUrl: result.authorizationUrl,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        return failure(res, error, "OTA_AIRBNB_CONNECTION_LINK_FAILED");
      }
    }
  );

  router.post(
    "/api/dashboard/distribution/airbnb/callback/verify",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled) {
        return res.status(503).json({
          ok: false,
          error: "OTA_AIRBNB_HOST_SELF_SERVICE_DISABLED",
        });
      }
      const currentActor = actor(req);
      if (!currentActor) {
        return res.status(403).json({ ok: false, error: "OTA_CONNECTION_MUTATION_FORBIDDEN" });
      }
      try {
        const result = await actions.verifyCallback({
          organizationId: currentActor.orgId,
          requestedByUserId: currentActor.id,
          success: String(req.body?.success ?? ""),
          channelId: req.body?.channelId == null ? null : String(req.body.channelId),
          token: String(req.body?.token ?? ""),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return failure(res, error, "OTA_AIRBNB_CALLBACK_VERIFICATION_FAILED");
      }
    }
  );

  // Read-only phase boundary. Mapping and activation are intentionally absent.
  router.get(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/:channelId/listings",
    requireAuth,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled) {
        return res.status(503).json({
          ok: false,
          error: "OTA_AIRBNB_HOST_SELF_SERVICE_DISABLED",
        });
      }
      const currentActor = actor(req);
      if (!currentActor) {
        return res.status(403).json({ ok: false, error: "OTA_CONNECTION_READ_FORBIDDEN" });
      }
      try {
        const result = await actions.discoverListings({
          organizationId: currentActor.orgId,
          propertyId: String(req.params.propertyId ?? ""),
          channelId: String(req.params.channelId ?? ""),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return failure(res, error, "OTA_AIRBNB_LISTINGS_DISCOVERY_FAILED");
      }
    }
  );

  return router;
}
