import { Router } from "express";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardMetricsRouter = Router();

function startEndOfTodayUTC() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  );
  return { now, start, end };
}

dashboardMetricsRouter.get("/api/dashboard/metrics", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const { now, start, end } = startEndOfTodayUTC();

  const [
    upcomingArrivals,
    inHouse,
    checkoutsToday,
    activeLocks,
    properties,
  ] = await Promise.all([
    prisma.reservation.count({
      where: {
        status: ReservationStatus.ACTIVE,
        checkIn: { gt: now },
        property: { organizationId: orgId },
      },
    }),

    prisma.reservation.count({
      where: {
        status: ReservationStatus.ACTIVE,
        checkIn: { lte: now },
        checkOut: { gt: now },
        property: { organizationId: orgId },
      },
    }),

    prisma.reservation.count({
      where: {
        status: ReservationStatus.ACTIVE,
        checkOut: { gte: start, lt: end },
        property: { organizationId: orgId },
      },
    }),

    prisma.lock.count({
      where: {
        isActive: true,
        property: { organizationId: orgId },
      },
    }),

    prisma.property.count({
      where: { organizationId: orgId },
    }),
  ]);

  return res.json({
    upcomingArrivals,
    inHouse,
    checkoutsToday,
    activeLocks,
    properties,
    updatedAt: new Date().toISOString(),
  });
});