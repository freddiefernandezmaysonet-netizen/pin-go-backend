import { Router } from "express";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { dashboardDistributionMissionControlMiddleware } from "./dashboard.distribution-mission-control.middleware";
import { dashboardManualReservationDateChangeRouter } from "./dashboard.manual-reservation-date-change.route";

const prisma = new PrismaClient();
export const dashboardRouter = Router();

dashboardRouter.use(dashboardDistributionMissionControlMiddleware);
dashboardRouter.use(dashboardManualReservationDateChangeRouter);

// MVP: "today" en UTC (luego lo hacemos por timezone de property)
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


dashboardRouter.get("/api/dashboard/overview", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const now = new Date();
  const todayWindows = await organizationPropertyTodayWindows(prisma, orgId, now);
  const checkInTodayWhere = todayWindows.map(({ propertyId, start, end }) => ({ propertyId, checkIn: { gte: start, lt: end } }));
  const checkOutTodayWhere = todayWindows.map(({ propertyId, start, end }) => ({ propertyId, checkOut: { gte: start, lt: end } }));

  const [activeReservations, checkInsToday, checkOutsToday, activeLocks] =
    await Promise.all([
      prisma.reservation.count({
        where: {
          status: ReservationStatus.ACTIVE,
          property: { organizationId: orgId },
        },
      }),
      prisma.reservation.count({
        where: {
          OR: checkInTodayWhere,
          status: { not: ReservationStatus.CANCELLED },
          property: { organizationId: orgId },
        },
      }),
      prisma.reservation.count({
        where: {
          OR: checkOutTodayWhere,
          status: { not: ReservationStatus.CANCELLED },
          property: { organizationId: orgId },
        },
      }),
      prisma.lock.count({
        where: {
          isActive: true,
          property: { organizationId: orgId },
        },
      }),
    ]);

  return res.json({
    activeReservations,
    checkInsToday,
    checkOutsToday,
    activeLocks,
    updatedAt: new Date().toISOString(),
  });
});
