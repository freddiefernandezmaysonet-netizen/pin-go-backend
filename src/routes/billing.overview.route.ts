import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

export function buildBillingOverviewRouter(prisma: PrismaClient) {
  const router = Router();

  router.get("/overview", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const subscription = await prisma.subscription.findUnique({
        where: { organizationId: orgId },
      });

      const activeLocks = await prisma.lock.count({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
        },
      });

      const activeSmartProperties = await prisma.property.count({
        where: {
          organizationId: orgId,
          smartAutomationEnabled: true,
        },
      });

      const entitledLocks = subscription?.entitledLocks ?? 0;
      const entitledSmartProperties = subscription?.entitledSmartProperties ?? 0;

      const remainingLocks = Math.max(entitledLocks - activeLocks, 0);
      const remainingSmartProperties = Math.max(
        entitledSmartProperties - activeSmartProperties,
        0
      );

      const usagePct =
        entitledLocks === 0
          ? 0
          : Math.round((activeLocks / entitledLocks) * 100);

      const smartUsagePct =
        entitledSmartProperties === 0
          ? 0
          : Math.round(
              (activeSmartProperties / entitledSmartProperties) * 100
            );

      return res.json({
        ok: true,
        subscription: {
          status: subscription?.status ?? null,

          stripeCustomerId: subscription?.stripeCustomerId ?? null,
          stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,

          entitledLocks,
          activeLocks,
          remainingLocks,
          usagePct,

          entitledSmartProperties,
          activeSmartProperties,
          remainingSmartProperties,
          smartUsagePct,

          currentPeriodStart: subscription?.currentPeriodStart ?? null,
          currentPeriodEnd: subscription?.currentPeriodEnd ?? null,

          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        },
      });
    } catch (err) {
      console.error("billing overview error", err);

      res.status(500).json({
        ok: false,
        error: "billing_overview_failed",
      });
    }
  });

  return router;
}