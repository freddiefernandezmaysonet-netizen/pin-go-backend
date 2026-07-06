import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  getDashboardCancellationPolicy,
  upsertDashboardCancellationPolicy,
} from "../services/cancellation-policy.service";

export const dashboardCancellationPolicyRouter = Router();

function getOrgIdFromRequest(req: any) {
  const orgId = req.user?.orgId;

  if (!orgId || typeof orgId !== "string") {
    throw Object.assign(new Error("Missing organization context."), {
      statusCode: 401,
      code: "MISSING_ORGANIZATION_CONTEXT",
    });
  }

  return orgId;
}

function sendCancellationPolicyError(res: any, error: any) {
  console.error("[DASHBOARD_CANCELLATION_POLICY_ERROR]", error);

  if (error?.message === "PROPERTY_NOT_FOUND") {
    return res.status(404).json({
      ok: false,
      error: "PROPERTY_NOT_FOUND",
      message: "Property not found.",
    });
  }

  return res.status(error?.statusCode || 500).json({
    ok: false,
    error: error?.code || "CANCELLATION_POLICY_ROUTE_ERROR",
    message:
      error?.message ||
      "Unable to process the cancellation policy request.",
    details: error?.details,
  });
}

dashboardCancellationPolicyRouter.get(
  "/api/dashboard/properties/:id/cancellation-policy",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);
      const propertyId = String(req.params.id ?? "").trim();

      if (!propertyId) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_PROPERTY_ID",
          message: "Missing property id.",
        });
      }

      const result = await getDashboardCancellationPolicy({
        organizationId,
        propertyId,
      });

      return res.json({
        ok: true,
        ...result,
      });
    } catch (error: any) {
      return sendCancellationPolicyError(res, error);
    }
  }
);

dashboardCancellationPolicyRouter.put(
  "/api/dashboard/properties/:id/cancellation-policy",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);
      const propertyId = String(req.params.id ?? "").trim();

      if (!propertyId) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_PROPERTY_ID",
          message: "Missing property id.",
        });
      }

      const result = await upsertDashboardCancellationPolicy({
        organizationId,
        propertyId,
        input: req.body ?? {},
      });

      return res.json({
        ok: true,
        ...result,
      });
    } catch (error: any) {
      return sendCancellationPolicyError(res, error);
    }
  }
);