import type { PrismaClient, Prisma } from "@prisma/client";
import { planCleanerAccessWindow } from "./cleaner-access-window.policy";

/** Read the next occupancy, including an arrival already overlapping departure. */
export async function readCleanerAccessWindow(db: Pick<PrismaClient | Prisma.TransactionClient, "reservation">,
  reservation: { id: string; propertyId: string; checkOut: Date; source?: string | null; externalId?: string | null;
    property: Parameters<typeof planCleanerAccessWindow>[0]["property"] }) {
  const next = await db.reservation.findFirst({
    where: { propertyId: reservation.propertyId, id: { not: reservation.id },
      status: { not: "CANCELLED" }, checkOut: { gt: reservation.checkOut } },
    orderBy: { checkIn: "asc" }, select: { checkIn: true },
  });
  const demoReservation =
    reservation.source === "INTERNAL_DEMO_DIRECT_BOOKING" ||
    String(reservation.externalId ?? "").startsWith("DEMO-");

  if (demoReservation) {
    const startsAt = new Date(
      reservation.checkOut.getTime() +
        reservation.property.cleaningStartOffsetMinutes * 60_000
    );
    const desiredEndsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const nextMs = next?.checkIn?.getTime() ?? Infinity;
    const endsAt = new Date(Math.min(desiredEndsAt.getTime(), nextMs));
    if (endsAt <= startsAt) throw new Error("CLEANER_ACCESS_WINDOW_EMPTY");
    return { startsAt, endsAt, durationMinutes: 30 };
  }

  return planCleanerAccessWindow({ checkOut: reservation.checkOut, property: reservation.property,
    nextCheckIn: next?.checkIn ?? null });
}
