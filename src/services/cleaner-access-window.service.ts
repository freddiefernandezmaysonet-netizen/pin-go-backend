import type { PrismaClient, Prisma } from "@prisma/client";
import { planCleanerAccessWindow } from "./cleaner-access-window.policy";

/** Read the next occupancy, including an arrival already overlapping departure. */
export async function readCleanerAccessWindow(db: Pick<PrismaClient | Prisma.TransactionClient, "reservation">,
  reservation: { id: string; propertyId: string; checkOut: Date;
    property: Parameters<typeof planCleanerAccessWindow>[0]["property"] }) {
  const next = await db.reservation.findFirst({
    where: { propertyId: reservation.propertyId, id: { not: reservation.id },
      status: { not: "CANCELLED" }, checkOut: { gt: reservation.checkOut } },
    orderBy: { checkIn: "asc" }, select: { checkIn: true },
  });
  return planCleanerAccessWindow({ checkOut: reservation.checkOut, property: reservation.property,
    nextCheckIn: next?.checkIn ?? null });
}
