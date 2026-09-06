import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth";
import {
  buildConnectionCenterReadModel,
  type ConnectionCenterProvider,
  type StoredOtaChannel,
} from "../distribution/connection-center.read-model";
import {
  createDistributionMutationSecurity,
  type DistributionMutationRequest,
} from "../distribution/distribution-mutation-security";
import type { OtaConnectionCenterRuntime } from "../distribution/ota-connection-runtime.policy";
import type { OtaChannelEvidenceResult } from "../distribution/channex-channel-lifecycle.evidence.js";
import { buildChannexChannelLifecycleWebhookRouter } from "./channex-channel-lifecycle.webhook.route.js";

type MutationActor = { id?: string; orgId?: string; role?: string };

export type DistributionConnectionCenterActions = {
  runtime: OtaConnectionCenterRuntime;
  isTrustedOrigin(origin: string, organizationId: string): Promise<boolean>;
  channelLifecycle?: {
    enabled: boolean;
    expectedSecret: string | null | undefined;
    applyEvidence(payload: unknown): Promise<OtaChannelEvidenceResult>;
  };
  prepare?(args: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    provider: ConnectionCenterProvider;
    requestKey: string;
  }): Promise<{ provisioningStatus: string }>;
  issueSession?(args: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    provider: ConnectionCenterProvider;
    requestKey: string;
  }): Promise<{ sessionId: string; token: string; launchUrl: string; expiresAt: Date }>;
  transitionSession?(args: {
    organizationId: string;
    requestedByUserId: string;
    sessionId: string;
    current: "TOKEN_ISSUED" | "OPENED" | "REQUESTED";
    next: "OPENED" | "COMPLETED" | "CANCELLED";
  }): Promise<void>;
};

const DEFAULT_ACTIONS: DistributionConnectionCenterActions = {
  runtime: { enabled: false, reason: "DEFAULT_OFF" },
  async isTrustedOrigin() { return false; },
};

function providerFromPath(value: string): ConnectionCenterProvider | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "AIRBNB" || normalized === "BOOKING_COM") return normalized;
  return null;
}

function mutationActor(req: DistributionMutationRequest): Required<MutationActor> {
  return req.user as Required<MutationActor>;
}

function mutationUnavailable(res: import("express").Response) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).json({
    ok: false,
    error: "OTA_CONNECTION_CENTER_RUNTIME_DISABLED",
  });
}

function mutationFailure(
  res: import("express").Response,
  error: unknown,
  fallback: string
) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : fallback;
  const status = code.includes("NOT_FOUND") ? 404 : code.includes("CONFLICT") || code.includes("ALREADY_USED") ? 409 : 422;
  return res.status(status).json({ ok: false, error: code });
}

export function buildDashboardDistributionConnectionCenterRouter(
  prisma: PrismaClient,
  actions: DistributionConnectionCenterActions = DEFAULT_ACTIONS
) {
  const router = Router();
  const mutationSecurity = createDistributionMutationSecurity({
    isTrustedOrigin: actions.isTrustedOrigin,
  });

  if (actions.channelLifecycle) {
    router.use(buildChannexChannelLifecycleWebhookRouter(actions.channelLifecycle));
  }

  for (const legacyMutationPath of [
    "/api/dashboard/properties/:propertyId/distribution/enable",
    "/api/dashboard/properties/:propertyId/channex/provision",
    "/api/dashboard/properties/:propertyId/channex/sync-availability",
  ]) {
    router.post(legacyMutationPath, requireAuth, (_req, res) =>
      res.status(409).json({
        ok: false,
        error: "OTA_DISTRIBUTION_CONNECTION_CENTER_REQUIRED",
      })
    );
  }

  router.post(
    "/api/dashboard/distribution/properties/:propertyId/channels/:provider/prepare",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.runtime.enabled || !actions.prepare) return mutationUnavailable(res);
      const provider = providerFromPath(req.params.provider ?? "");
      if (!provider) return res.status(422).json({ ok: false, error: "OTA_CONNECTION_PROVIDER_UNAVAILABLE" });
      const actor = mutationActor(req);
      try {
        const result = await actions.prepare({
          organizationId: actor.orgId,
          propertyId: String(req.params.propertyId ?? "").trim(),
          requestedByUserId: actor.id,
          provider,
          requestKey: req.distributionRequestKey!,
        });
        return res.json({ ok: true, provisioningStatus: result.provisioningStatus });
      } catch (error) {
        return mutationFailure(res, error, "OTA_CONNECTION_PREPARE_FAILED");
      }
    }
  );

  router.post(
    "/api/dashboard/distribution/properties/:propertyId/channels/:provider/session",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.runtime.enabled || !actions.issueSession) return mutationUnavailable(res);
      const provider = providerFromPath(req.params.provider ?? "");
      if (!provider) return res.status(422).json({ ok: false, error: "OTA_CONNECTION_PROVIDER_UNAVAILABLE" });
      const actor = mutationActor(req);
      try {
        const session = await actions.issueSession({
          organizationId: actor.orgId,
          propertyId: String(req.params.propertyId ?? "").trim(),
          requestedByUserId: actor.id,
          provider,
          requestKey: req.distributionRequestKey!,
        });
        const { token: _token, ...publicSession } = session;
        return res.json({
          ok: true,
          session: {
            ...publicSession,
            expiresAt: publicSession.expiresAt.toISOString(),
          },
        });
      } catch (error) {
        return mutationFailure(res, error, "OTA_CONNECTION_SESSION_FAILED");
      }
    }
  );

  router.post(
    "/api/dashboard/distribution/sessions/:sessionId/:event(opened|completed|cancelled)",
    requireAuth,
    mutationSecurity,
    async (req: DistributionMutationRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!actions.runtime.enabled || !actions.transitionSession) return mutationUnavailable(res);
      const event = String(req.params.event ?? "");
      const transition = event === "opened"
        ? { current: "TOKEN_ISSUED" as const, next: "OPENED" as const }
        : event === "completed"
          ? { current: "OPENED" as const, next: "COMPLETED" as const }
          : { current: "OPENED" as const, next: "CANCELLED" as const };
      const actor = mutationActor(req);
      try {
        await actions.transitionSession({
          organizationId: actor.orgId,
          requestedByUserId: actor.id,
          sessionId: String(req.params.sessionId ?? "").trim(),
          ...transition,
        });
        return res.json({ ok: true });
      } catch (error) {
        return mutationFailure(res, error, "OTA_CONNECTION_TRANSITION_FAILED");
      }
    }
  );

  router.get(
    "/api/dashboard/distribution/properties/:propertyId",
    requireAuth,
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");

      try {
        const organizationId = String((req as any).user?.orgId ?? "").trim();
        const propertyId = String(req.params.propertyId ?? "").trim();
        const property = await prisma.property.findFirst({
          where: { id: propertyId, organizationId, status: "ACTIVE" },
          select: { id: true, name: true },
        });

        if (!property) {
          return res.status(404).json({
            ok: false,
            error: "DISTRIBUTION_PROPERTY_NOT_FOUND",
          });
        }

        const distributionProperty =
          await prisma.distributionProperty.findFirst({
            where: { propertyId: property.id, organizationId, platform: "CHANNEX" },
            select: {
              organizationId: true,
              provisioningStatus: true,
              otaChannelConnections: {
                select: {
                  organizationId: true,
                  propertyId: true,
                  provider: true,
                  status: true,
                  authorizationReadiness: true,
                  mappingReadiness: true,
                  distributionReadiness: true,
                  paymentReadiness: true,
                  taxReadiness: true,
                  contentReadiness: true,
                  lastReadinessCheckedAt: true,
                  lastFullSyncConfirmedAt: true,
                  activatedAt: true,
                  lastErrorCode: true,
                },
                orderBy: { provider: "asc" },
              },
            },
          });

        if (
          distributionProperty &&
          (distributionProperty.organizationId !== organizationId ||
            distributionProperty.otaChannelConnections.some(
              (channel) =>
                channel.organizationId !== organizationId ||
                channel.propertyId !== property.id
            ))
        ) {
          return res.status(409).json({
            ok: false,
            error: "OTA_DISTRIBUTION_TENANT_MISMATCH",
          });
        }

        const connectionCenter = buildConnectionCenterReadModel({
          property,
          distributionProperty: distributionProperty
            ? {
                provisioningStatus: distributionProperty.provisioningStatus,
                channels:
                  distributionProperty.otaChannelConnections as Array<
                    StoredOtaChannel & { provider: ConnectionCenterProvider }
                  >,
              }
            : null,
        });

        return res.json({ ok: true, connectionCenter });
      } catch (error) {
        console.error("[distribution.connection-center] lookup failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return res.status(500).json({
          ok: false,
          error: "DISTRIBUTION_CONNECTION_CENTER_FETCH_FAILED",
        });
      }
    }
  );

  return router;
}
