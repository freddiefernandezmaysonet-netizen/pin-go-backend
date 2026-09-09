import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth.js";
import {
  createDistributionMutationSecurity,
  type DistributionMutationRequest,
} from "../distribution/distribution-mutation-security.js";

const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);

type Actor = { id?: string; orgId?: string; role?: string };

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
    propertyId: string;
    channelId: string | null;
    channelActive: boolean | null;
    nextAction: "RETRY_AUTHORIZATION" | "MAPPING_REQUIRED";
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

  return router;
}
