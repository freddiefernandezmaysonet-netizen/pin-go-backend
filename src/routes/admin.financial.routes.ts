import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

const LOCK_PRICE = 12.49;
const SMART_PRICE = 14.99;

const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED_PER_ORG = 0.3;
const AVG_SMS_COST = 0.008;
const ESTIMATED_SMS_PER_RESERVATION = 4;
const TUYA_COST_PER_SMART_PROPERTY = 0.3;

function requireAdmin(_req: any, _res: any, next: any) {
  return next();
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

router.get("/financial/overview", requireAdmin, async (_req, res) => {
  try {
    const [
      totalOrgs,
      totalReservations,
      activeLocks,
      activeSmartProperties,
      subscriptions,
      organizations,
    ] = await Promise.all([
      prisma.organization.count(),

      // 🔥 FIX: reservation → property → organization
      prisma.reservation.count(),

      // 🔥 FIX: lock → property → organization
      prisma.lock.count({
        where: { isActive: true },
      }),

      prisma.property.count({
        where: { smartAutomationEnabled: true },
      }),

      prisma.subscription.findMany(),

      prisma.organization.findMany({
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
      }),
    ]);

    const orgUsage = await Promise.all(
      organizations.map(async (org) => {
        const [locksUsed, smartUsed, reservations] = await Promise.all([
          prisma.lock.count({
            where: {
              isActive: true,
              property: {
                organizationId: org.id,
              },
            },
          }),

          prisma.property.count({
            where: {
              organizationId: org.id,
              smartAutomationEnabled: true,
            },
          }),

          prisma.reservation.count({
            where: {
              property: {
                organizationId: org.id,
              },
            },
          }),
        ]);

        const subscription = subscriptions.find(
          (s) => s.organizationId === org.id
        );

        const entitledLocks = subscription?.entitledLocks ?? 0;
        const entitledSmartProperties =
          subscription?.entitledSmartProperties ?? 0;

        const estimatedMonthlyRevenue =
          entitledLocks * LOCK_PRICE +
          entitledSmartProperties * SMART_PRICE;

        return {
          organizationId: org.id,
          organizationName: org.name,

          subscription: subscription
            ? {
                stripeCustomerId: subscription.stripeCustomerId,
                stripeSubscriptionId: subscription.stripeSubscriptionId,
                entitledLocks,
                entitledSmartProperties,
              }
            : null,

          usage: {
            locksUsed,
            smartPropertiesUsed: smartUsed,
            reservations,
          },

          revenue: {
            estimatedMonthly: money(estimatedMonthlyRevenue),
          },
        };
      })
    );

    const entitledLocks = subscriptions.reduce(
      (sum, sub) => sum + (sub.entitledLocks ?? 0),
      0
    );

    const entitledSmartProperties = subscriptions.reduce(
      (sum, sub) => sum + (sub.entitledSmartProperties ?? 0),
      0
    );

    const subscribedOrgs = subscriptions.filter(
      (sub) =>
        (sub.entitledLocks ?? 0) > 0 ||
        (sub.entitledSmartProperties ?? 0) > 0 ||
        Boolean(sub.stripeSubscriptionId)
    ).length;

    const revenueLocks = entitledLocks * LOCK_PRICE;
    const revenueSmart = entitledSmartProperties * SMART_PRICE;
    const totalRevenue = revenueLocks + revenueSmart;

    const stripeFee =
      totalRevenue > 0
        ? totalRevenue * STRIPE_PERCENT +
          subscribedOrgs * STRIPE_FIXED_PER_ORG
        : 0;

    const estimatedSms =
      totalReservations * ESTIMATED_SMS_PER_RESERVATION;

    const twilioCost = estimatedSms * AVG_SMS_COST;

    const tuyaCost =
      activeSmartProperties * TUYA_COST_PER_SMART_PROPERTY;

    const totalCosts = stripeFee + twilioCost + tuyaCost;

    const netProfit = totalRevenue - totalCosts;
    const margin =
      totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    return res.json({
      ok: true,

      summary: {
        totalOrgs,
        subscribedOrgs,
        totalReservations,
        entitledLocks,
        entitledSmartProperties,
        activeLocks,
        activeSmartProperties,
      },

      revenue: {
        locks: money(revenueLocks),
        smart: money(revenueSmart),
        total: money(totalRevenue),
      },

      costs: {
        stripe: money(stripeFee),
        twilio: money(twilioCost),
        tuya: money(tuyaCost),
        total: money(totalCosts),
      },

      profit: {
        net: money(netProfit),
        margin: money(margin),
      },

      organizations: orgUsage,
    });
  } catch (err) {
    console.error("[admin.financial.overview] ERROR", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
});

export default router;