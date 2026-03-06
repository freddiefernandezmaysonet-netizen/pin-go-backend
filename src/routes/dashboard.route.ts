import { Router } from "express";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardRouter = Router();

// MVP: "today" en UTC (luego lo hacemos por timezone de property)
function startEndOfTodayUTC() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return { start, end };
}

dashboardRouter.get("/api/dashboard/overview", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const { start, end } = startEndOfTodayUTC();

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
          checkIn: { gte: start, lt: end },
          status: { not: ReservationStatus.CANCELLED },
          property: { organizationId: orgId },
        },
      }),
      prisma.reservation.count({
        where: {
          checkOut: { gte: start, lt: end },
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