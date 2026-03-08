import { Router } from "express";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
export const dashboardPropertiesRouter = Router();

function getOperationalStatus(r: {
  status: ReservationStatus;
  checkIn: Date;
  checkOut: Date;
}) {
  const now = new Date();

  if (r.status === ReservationStatus.CANCELLED) return "CANCELLED";
  if (now < r.checkIn) return "UPCOMING";
  if (now >= r.checkIn && now < r.checkOut) return "IN_HOUSE";
  return "CHECKED_OUT";
}

dashboardPropertiesRouter.get("/api/dashboard/properties", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const rows = await prisma.property.findMany({
    where: { organizationId: orgId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      locks: {
        where: { isActive: true },
        select: { id: true },
      },
      reservations: {
        where: { status: ReservationStatus.ACTIVE },
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          status: true,
          externalProvider: true,
          source: true,
        },
      },
    },
  });

  const items = rows.map((p) => {
    const operationalReservations = p.reservations.filter((r) => {
      const operationalStatus = getOperationalStatus(r);
      return operationalStatus === "UPCOMING" || operationalStatus === "IN_HOUSE";
    });

    const firstRes = p.reservations[0];

    return {
      id: p.id,
      name: p.name,
      locks: p.locks.length,
      activeReservations: operationalReservations.length,
      pms: firstRes?.externalProvider ?? firstRes?.source ?? "manual",
      status: "ACTIVE",
    };
  });

  res.json({ items });
});