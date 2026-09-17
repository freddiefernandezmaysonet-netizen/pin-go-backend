import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { createConnectDashboardLoginLink } from "../services/stripe-connect-dashboard-link.service.js";
import {
  createConnectOnboardingLink,
  getOrganizationPayoutStatus,
  syncConnectAccountStatus,
} from "../services/stripe-connect.service.js";
import {
  createStripeConnectIsolationV2Account,
  createStripeConnectIsolationV2AccountSession,
} from "../services/stripe-connect-isolation-v2.service.js";

const prisma = new PrismaClient();

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

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, any>;
}

function money(value: unknown) {
  if (value === null || value === undefined) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
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

dashboardPayoutsRouter.get(
  "/api/dashboard/payouts/transactions",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);
      const limit = positiveInt(req.query.limit, 25, 100);

      const reservations = await prisma.reservation.findMany({
        where: {
          property: {
            organizationId,
          },
          OR: [
            { source: "DIRECT_BOOKING" },
            { externalProvider: "PIN_GO_DIRECT" },
          ],
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limit,
        select: {
          id: true,
          reservationNumber: true,
          createdAt: true,
          checkIn: true,
          checkOut: true,
          amountCollected: true,
          totalAmount: true,
          currency: true,
          paymentState: true,
          basePlatformFeeAmount: true,
          directBookingProtectionFeeAmount: true,
          platformFeeAmount: true,
          hostPayoutAmount: true,
          hostPayoutStatus: true,
          hostPayoutLastSyncedAt: true,
          externalRaw: true,
          property: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      const items = reservations.map((reservation) => {
        const externalRaw = asRecord(reservation.externalRaw);
        const financialEvidence = asRecord(
          externalRaw.stripeFinancialEvidence
        );
        const hasActualDirectChargeEvidence =
          financialEvidence.chargeMode === "DIRECT_CHARGE" &&
          financialEvidence.source === "STRIPE_BALANCE_TRANSACTION";

        const stripeProcessingFeeAmount = hasActualDirectChargeEvidence
          ? money(financialEvidence.stripeProcessingFeeAmount)
          : null;
        const applicationFeeAmount = hasActualDirectChargeEvidence
          ? money(financialEvidence.applicationFeeAmount)
          : null;
        const actualHostNetAmount = hasActualDirectChargeEvidence
          ? money(financialEvidence.hostNetAmount)
          : null;

        return {
          reservationId: reservation.id,
          reservationNumber: reservation.reservationNumber,
          property: {
            id: reservation.property.id,
            name: reservation.property.name,
          },
          createdAt: reservation.createdAt.toISOString(),
          checkIn: reservation.checkIn.toISOString(),
          checkOut: reservation.checkOut.toISOString(),
          currency: reservation.currency ?? "usd",
          paymentState: reservation.paymentState,
          guestPaidAmount:
            money(reservation.amountCollected) ?? money(reservation.totalAmount),
          pingoPlatformFeeAmount: money(reservation.basePlatformFeeAmount),
          identityCheckFeeAmount: money(
            reservation.directBookingProtectionFeeAmount
          ),
          totalPinGoFeeAmount: money(reservation.platformFeeAmount),
          applicationFeeAmount,
          applicationFeeActual: applicationFeeAmount !== null,
          stripeProcessingFeeAmount,
          stripeProcessingFeeActual: stripeProcessingFeeAmount !== null,
          stripeFeeSource: hasActualDirectChargeEvidence
            ? "STRIPE_BALANCE_TRANSACTION"
            : null,
          recordedHostPayoutAmount: money(reservation.hostPayoutAmount),
          hostNetAmount: actualHostNetAmount,
          hostPayoutStatus: reservation.hostPayoutStatus,
          lastSyncedAt:
            reservation.hostPayoutLastSyncedAt?.toISOString() ?? null,
        };
      });

      return res.json({
        ok: true,
        items,
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
  "/api/dashboard/payouts/login-link",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);

      const loginLink = await createConnectDashboardLoginLink(
        organizationId
      );

      return res.json({
        ok: true,
        loginLink,
      });
    } catch (error: any) {
      return sendRouteError(res, error);
    }
  }
);

dashboardPayoutsRouter.post(
  "/api/dashboard/payouts/connect-isolation-v2/account",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);
      const account = await createStripeConnectIsolationV2Account(
        organizationId
      );

      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({
        ok: true,
        account,
      });
    } catch (error: any) {
      return sendRouteError(res, error);
    }
  }
);

dashboardPayoutsRouter.post(
  "/api/dashboard/payouts/connect-isolation-v2/account-session",
  requireAuth,
  async (req, res) => {
    try {
      const organizationId = getOrgIdFromRequest(req);
      const accountSession =
        await createStripeConnectIsolationV2AccountSession(organizationId);

      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ok: true,
        accountSession,
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