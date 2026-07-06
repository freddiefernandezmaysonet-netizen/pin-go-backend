import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  createConnectOnboardingLink,
  getOrganizationPayoutStatus,
  syncConnectAccountStatus,
} from "../services/stripe-connect.service";

export const dashboardPayoutsRouter = Router();

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

function sendRouteError(res: any, error: any) {
  console.error("Dashboard payouts route error", error);

  return res.status(error?.statusCode || 500).json({
    ok: false,
    error: error?.code || "PAYOUTS_ROUTE_ERROR",
    message:
      error?.message ||
      "Something went wrong while processing the host payout request.",
    details: error?.details,
  });
}

dashboardPayoutsRouter.get(
  "/api/dashboard/payouts/status",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);

      const payoutStatus = await getOrganizationPayoutStatus(organizationId);

      return res.json({
        ok: true,
        payoutStatus,
      });
    } catch (error: any) {
      return sendRouteError(res, error);
    }
  }
);

dashboardPayoutsRouter.post(
  "/api/dashboard/payouts/onboarding-link",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);

      const onboardingLink = await createConnectOnboardingLink(organizationId);

      return res.json({
        ok: true,
        onboardingLink,
      });
    } catch (error: any) {
      return sendRouteError(res, error);
    }
  }
);

dashboardPayoutsRouter.post(
  "/api/dashboard/payouts/sync",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);

      const payoutStatus = await syncConnectAccountStatus(organizationId);

      return res.json({
        ok: true,
        payoutStatus,
      });
    } catch (error: any) {
      return sendRouteError(res, error);
    }
  }
);