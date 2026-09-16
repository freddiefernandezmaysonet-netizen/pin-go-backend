import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { summarizeSmsFinancialTelemetry } from "../services/sms-financial-telemetry.service";
import { getStripeFinancialActuals } from "../services/stripe-financial-adapter.service";

const prisma = new PrismaClient();
const router = Router();

const LOCK_PRICE = 12.49;
const SMART_PRICE = 14.99;

const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED_PER_ORG = 0.3;
const TUYA_COST_PER_SMART_PROPERTY = 0.3;

function assertPlatformAdmin(req: any, res: any) {
  const user = req.user;

  if (!user || user.role !== "PLATFORM_ADMIN") {
    res.status(403).json({
      ok: false,
      error: "Forbidden",
    });
    return false;
  }

  return true;
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

router.get("/financial/overview", requireAuth, async (req, res) => {
  try {
    if (!assertPlatformAdmin(req, res)) return;

    // 🔥 ÚLTIMOS 30 DÍAS
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [
      totalOrgs,
      activeLocks,
      activeSmartProperties,
      subscriptions,
      organizations,
      totalReservations,
      twilioSmsMessages,
      totalAutomationExecutions,
      stripeActuals,
    ] = await Promise.all([
      prisma.organization.count(),

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

      // 🔥 SOLO 30 DÍAS
      prisma.reservation.count({
        where: {
          createdAt: {
            gte: since,
          },
        },
      }),

      prisma.messageLog.findMany({
        where: {
          channel: "sms",
          provider: "twilio",
          status: "SENT",
          createdAt: {
            gte: since,
          },
        },
        select: {
          body: true,
          organizationId: true,
        },
      }),

      prisma.automationExecutionLog.count({
        where: {
          executedAt: {
            gte: since,
          },
        },
      }),

      getStripeFinancialActuals(prisma, { since }),
    ]);

    const smsTelemetry = summarizeSmsFinancialTelemetry(
      twilioSmsMessages
    );

    const smsMessagesByOrg = new Map<
      string,
      Array<{ body: string | null }>
    >();

    for (const message of twilioSmsMessages) {
      if (!message.organizationId) continue;
      const rows = smsMessagesByOrg.get(
        message.organizationId
      ) ?? [];
      rows.push({ body: message.body });
      smsMessagesByOrg.set(
        message.organizationId,
        rows
      );
    }

    const orgUsage = await Promise.all(
      organizations.map(async (org) => {
        const [
          locksUsed,
          smartUsed,
          reservations,
          automationExecutions,
        ] = await Promise.all([
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

          // 🔥 SOLO 30 DÍAS
          prisma.reservation.count({
            where: {
              property: {
                organizationId: org.id,
              },
              createdAt: {
                gte: since,
              },
            },
          }),

          prisma.automationExecutionLog.count({
            where: {
              organizationId: org.id,
              executedAt: {
                gte: since,
              },
            },
          }),
        ]);

        const orgSmsTelemetry = summarizeSmsFinancialTelemetry(
          smsMessagesByOrg.get(org.id) ?? []
        );

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
            reservations, // últimos 30 días
            smsUsed: orgSmsTelemetry.totalMessages, // últimos 30 días
            smsSegments: orgSmsTelemetry.totalSegments,
            automationExecutions, // últimos 30 días
          },

          revenue: {
            estimatedMonthly: money(estimatedMonthlyRevenue),
          },
        };
      })
    );

    // 🔥 TOP CLIENTES
    orgUsage.sort(
      (a, b) => b.revenue.estimatedMonthly - a.revenue.estimatedMonthly
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

    // Costo base estimado por segmentos de SMS enviados (30 días).
    // No incluye carrier fees ni ajustes posteriores de factura Twilio.
    const twilioCost = smsTelemetry.estimatedCostUsd;

    const tuyaCost =
      activeSmartProperties * TUYA_COST_PER_SMART_PROPERTY;

    const totalCosts = stripeFee + twilioCost + tuyaCost;

    const netProfit = totalRevenue - totalCosts;
    const margin =
      totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    return res.json({
      ok: true,

      period: "LAST_30_DAYS", // 🔥 CLARIDAD

      summary: {
        totalOrgs,
        subscribedOrgs,
        totalReservations, // 30 días
        entitledLocks,
        entitledSmartProperties,
        activeLocks,
        activeSmartProperties,
        totalSmsMessages: smsTelemetry.totalMessages, // 30 días
        totalSmsSegments: smsTelemetry.totalSegments,
        twilioSmsSegmentRateUsd: smsTelemetry.segmentRateUsd,
        smsCostEstimateBasis:
          "SENT_TWILIO_MESSAGE_LOG_BODY_SEGMENTS_BASE_RATE",
        totalAutomationExecutions, // 30 días
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

      stripeActuals,

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