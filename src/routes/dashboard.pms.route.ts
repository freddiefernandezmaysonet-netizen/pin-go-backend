import { Router } from "express";
import { PrismaClient, PmsProvider } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardPmsRouter = Router();

dashboardPmsRouter.get("/api/dashboard/pms-summary", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const orgId = user.orgId as string;

    const providers: PmsProvider[] = [
      PmsProvider.GUESTY,
      PmsProvider.CLOUDBEDS,
      PmsProvider.HOSTAWAY,
    ];

    const connections = await prisma.pmsConnection.findMany({
      where: {
        organizationId: orgId,
        provider: { in: providers },
      },
      select: {
        id: true,
        provider: true,
        status: true,
        metadata: true,
        updatedAt: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    const items = await Promise.all(
      providers.map(async (provider) => {
        const connection =
          connections.find((c) => c.provider === provider) ?? null;

        if (!connection) {
          return {
            provider,
            connected: false,
            status: "NOT_CONFIGURED",
            accountName: null,
            lastConfiguredAt: null,
            pendingListings: 0,
            mappedListings: 0,
            totalListings: 0,
            failedWebhookEvents: 0,
          };
        }

        const [pendingListings, mappedListings, totalListings, failedWebhookEvents] =
          await Promise.all([
            prisma.pmsListing.count({
              where: {
                connectionId: connection.id,
                propertyId: null,
              },
            }),
            prisma.pmsListing.count({
              where: {
                connectionId: connection.id,
                propertyId: {
                  not: null,
                },
              },
            }),
            prisma.pmsListing.count({
              where: {
                connectionId: connection.id,
              },
            }),
            prisma.webhookEventIngest.count({
              where: {
                connectionId: connection.id,
                status: "FAILED",
              },
            }),
          ]);

        return {
          provider,
          connected: true,
          status: connection.status,
          accountName: connection.metadata?.accountName ?? null,
          lastConfiguredAt:
            connection.metadata?.lastConfiguredAt ??
            connection.updatedAt.toISOString(),
          pendingListings,
          mappedListings,
          totalListings,
          failedWebhookEvents,
        };
      })
    );

    const totals = items.reduce(
      (acc, item) => {
        acc.pendingListings += item.pendingListings;
        acc.mappedListings += item.mappedListings;
        acc.totalListings += item.totalListings;
        acc.failedWebhookEvents += item.failedWebhookEvents;
        return acc;
      },
      {
        pendingListings: 0,
        mappedListings: 0,
        totalListings: 0,
        failedWebhookEvents: 0,
      }
    );

    return res.json({
      items,
      totals,
    });
  } catch (e: any) {
    console.error("dashboard pms summary error", e);
    return res.status(500).json({
      error: e?.message ?? "failed",
    });
  }
});