import { Router } from "express";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardMetricsRouter = Router();

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

function propertyTodayWindow(now: Date, timezone: string) {
  const dateKey = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const start = fromZonedTime(`${dateKey}T00:00:00`, timezone);
  const nextDateKey = formatInTimeZone(
    new Date(start.getTime() + 36 * 60 * 60 * 1000),
    timezone,
    "yyyy-MM-dd"
  );
  const end = fromZonedTime(`${nextDateKey}T00:00:00`, timezone);
  return { start, end };
}

async function organizationPropertyTodayWindows(prisma: PrismaClient, organizationId: string, now: Date) {
  const properties = await prisma.property.findMany({
    where: { organizationId },
    select: { id: true, timezone: true },
  });
  return properties.map((property) => ({
    propertyId: property.id,
    ...propertyTodayWindow(now, property.timezone),
  }));
}


dashboardMetricsRouter.get("/api/dashboard/metrics", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const now = new Date();
  const todayWindows = await organizationPropertyTodayWindows(prisma, orgId, now);
  const todayWhere = todayWindows.map(({ propertyId, start, end }) => ({ propertyId, checkOut: { gte: start, lt: end } }));

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
        OR: todayWhere,
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