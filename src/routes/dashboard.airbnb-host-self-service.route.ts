import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth.js";
import type { AirbnbListingDiscoveryResult } from "../distribution/airbnb-host-self-service.listings.service.js";
import type { AirbnbHostConfirmedMappingResult } from "../distribution/airbnb-host-confirmed-mapping.service.js";
import type { AirbnbActivationState, AirbnbActivationResult } from "../distribution/airbnb-host-activation.service.js";
import {
  createDistributionMutationSecurity,
  type DistributionMutationRequest,
} from "../distribution/distribution-mutation-security.js";

const ADMIN_ROLES = new Set(["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"]);

type Actor = { id?: string; orgId?: string; role?: string };

export type AirbnbHostSelfServiceRouteActions = {
  enabled: boolean;
  inspectActivation?(args: { organizationId: string; propertyId: string }): Promise<AirbnbActivationState>;
  activate?(args: { organizationId: string; propertyId: string; requestedByUserId: string; requestKey: string;
    channelId: string; mappingId: string; listingId: string; confirmation: string }): Promise<AirbnbActivationResult>;
  verifyActivation?(args: { organizationId: string; propertyId: string; requestedByUserId: string; requestKey: string;
    channelId: string; mappingId: string; listingId: string; confirmation: string }): Promise<AirbnbActivationResult>;
  isTrustedOrigin(origin: string, organizationId: string): Promise<boolean>;
  issueConnectionLink(args: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    requestKey: string;
  }): Promise<{ authorizationUrl: string; expiresAt: Date }>;
  listListings(args: {
    organizationId: string;
    propertyId: string;
  }): Promise<AirbnbListingDiscoveryResult>;
  confirmMapping?(args: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    requestKey: string;
    listingId: string;
    confirmation: string;
  }): Promise<AirbnbHostConfirmedMappingResult>;
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
      : code.includes("CONFLICT")
        ? 409
        : code.includes("RATE_LIMITED")
          ? 429
          : code.includes("UNAVAILABLE") ||
              code.includes("RECONCILIATION_REQUIRED") ||
              code === "OTA_AIRBNB_MAPPING_RESPONSE_INVALID" ||
              code === "OTA_AIRBNB_MAPPING_RESPONSE_TOO_LARGE"
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

  router.get(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/listings",
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
        return res.status(403).json({
          ok: false,
          error: "OTA_CONNECTION_MUTATION_FORBIDDEN",
        });
      }
      try {
        const result = await actions.listListings({
          organizationId: currentActor.orgId,
          propertyId: String(req.params.propertyId ?? "").trim(),
        });
        return res.json({
          ok: true,
          listings: result.listings,
          match: result.match,
        });
      } catch (error) {
        return failure(res, error, "OTA_AIRBNB_LISTING_DISCOVERY_FAILED");
      }
    }
  );

  router.post(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/mapping",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled || !actions.confirmMapping) {
        return res.status(503).json({
          ok: false,
          error: "OTA_AIRBNB_MAPPING_UNAVAILABLE",
        });
      }
      const currentActor = actor(req);
      if (!currentActor) {
        return res.status(403).json({
          ok: false,
          error: "OTA_CONNECTION_MUTATION_FORBIDDEN",
        });
      }
      try {
        const result = await actions.confirmMapping({
          organizationId: currentActor.orgId,
          propertyId: String(req.params.propertyId ?? "").trim(),
          requestedByUserId: currentActor.id,
          requestKey: req.distributionRequestKey!,
          listingId: String(req.body?.listingId ?? "").trim(),
          confirmation: String(req.body?.confirmation ?? ""),
        });
        return res.json({
          ok: true,
          mapping: {
            outcome: result.outcome,
            listingId: result.listingId,
          },
        });
      } catch (error) {
        return failure(res, error, "OTA_AIRBNB_MAPPING_FAILED");
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

  router.get(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/activation",
    requireAuth,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled || !actions.inspectActivation) return res.status(503).json({ ok: false, error: "OTA_AIRBNB_ACTIVATION_UNAVAILABLE" });
      const currentActor = actor(req);
      if (!currentActor) return res.status(403).json({ ok: false, error: "OTA_CONNECTION_MUTATION_FORBIDDEN" });
      try {
        const activation = await actions.inspectActivation({ organizationId: currentActor.orgId, propertyId: String(req.params.propertyId ?? "").trim() });
        return res.json({ ok: true, activation });
      } catch (error) { return failure(res, error, "OTA_AIRBNB_ACTIVATION_CHECK_UNAVAILABLE"); }
    }
  );
  router.post(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/activate",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled || !actions.activate) return res.status(503).json({ ok: false, error: "OTA_AIRBNB_ACTIVATION_UNAVAILABLE" });
      const currentActor = actor(req);
      if (!currentActor) return res.status(403).json({ ok: false, error: "OTA_CONNECTION_MUTATION_FORBIDDEN" });
      try {
        const activation = await actions.activate({
          organizationId: currentActor.orgId, propertyId: String(req.params.propertyId ?? "").trim(),
          requestedByUserId: currentActor.id, requestKey: req.distributionRequestKey!,
          channelId: typeof req.body?.channelId === "string" ? req.body.channelId : "",
          mappingId: typeof req.body?.mappingId === "string" ? req.body.mappingId : "",
          listingId: typeof req.body?.listingId === "string" ? req.body.listingId : "",
          confirmation: typeof req.body?.confirmation === "string" ? req.body.confirmation : "",
        });
        return res.json({ ok: true, activation });
      } catch (error) { return failure(res, error, "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED"); }
    }
  );
  router.post(
    "/api/dashboard/distribution/properties/:propertyId/channels/AIRBNB/activation/verify",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.enabled || !actions.verifyActivation) return res.status(503).json({ ok: false, error: "OTA_AIRBNB_ACTIVATION_UNAVAILABLE" });
      const currentActor = actor(req);
      if (!currentActor) return res.status(403).json({ ok: false, error: "OTA_CONNECTION_MUTATION_FORBIDDEN" });
      try {
        const activation = await actions.verifyActivation({
          organizationId: currentActor.orgId, propertyId: String(req.params.propertyId ?? "").trim(),
          requestedByUserId: currentActor.id, requestKey: req.distributionRequestKey!,
          channelId: typeof req.body?.channelId === "string" ? req.body.channelId : "",
          mappingId: typeof req.body?.mappingId === "string" ? req.body.mappingId : "",
          listingId: typeof req.body?.listingId === "string" ? req.body.listingId : "",
          confirmation: typeof req.body?.confirmation === "string" ? req.body.confirmation : "",
        });
        return res.json({ ok: true, activation });
      } catch (error) { return failure(res, error, "OTA_AIRBNB_ACTIVATION_RECONCILIATION_REQUIRED"); }
    }
  );

  return router;
}
